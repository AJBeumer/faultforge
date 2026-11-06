/**
 * Waits until Qodo has really finished reviewing a PR's head commit, then saves everything.
 *
 *   npm run review:wait -- faultforge 55
 *   npm run review:wait -- target 9 --timeout 30
 *
 * A Qodo comment is not a finished review: on Day 3 it twice said "no open findings" and was edited
 * minutes later to add findings. Only Qodo's API saying the run for the head commit is `completed`
 * counts. Read-only throughout. Exits 0 when the review is complete, 1 when it timed out, 3 when
 * Qodo finished the run but skipped reviewing it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFactory, repoConfig } from "./factory-config.ts";
import { QodoApi } from "./qodo-api.ts";

/** The parts of Qodo's `get-pr-review-findings` (extended) response this uses. */
export interface QodoReview {
  ab_test_name?: string | null;
  ab_arm?: string | null;
  review_session?: { commit_sha?: string; status?: string; review_complete?: boolean; started_at?: string } | null;
  review_runs?: { commit_sha?: string; run_id?: number; review_effort?: string | null; status?: string }[];
  findings?: {
    id: string;
    git_sha: string;
    file_path?: string | null;
    start_line?: number | null;
    end_line?: number | null;
    action_level?: string | null;
    category?: string | null;
    title?: string | null;
    description?: string | null;
    attribution_status?: string | null;
    dismiss_reason?: string | null;
  }[];
}

export interface Finding {
  id: string;
  file: string | null;
  lines: [number, number] | null;
  severity: string | null;
  category: string | null;
  title: string | null;
  description: string | null;
}

/**
 * "complete" only when the run for exactly this commit is completed. "skipped" when Qodo finished the
 * run but chose not to review it (`review_effort: "skip"`, seen on a docs-only PR): its comment then
 * shows zero findings, which looks like a clean review but isn't one.
 */
export function reviewState(review: QodoReview, headSha: string): "complete" | "skipped" | "running" | "not-started" {
  const session = review.review_session;
  if (!session || session.commit_sha !== headSha) return "not-started";
  if (session.status !== "completed") return "running";
  if (session.review_complete) return "complete";
  const run = review.review_runs?.find((r) => r.commit_sha === headSha);
  return run?.review_effort === "skip" ? "skipped" : "running";
}

/** The findings Qodo raised on this commit, in a stable shape. */
export function findingsFor(review: QodoReview, headSha: string): Finding[] {
  return (review.findings ?? [])
    .filter((f) => f.git_sha === headSha)
    .map((f) => ({
      id: f.id,
      file: f.file_path ?? null,
      lines: f.start_line && f.end_line ? [f.start_line, f.end_line] : null,
      severity: f.action_level ?? null,
      category: f.category ?? null,
      title: f.title ?? null,
      description: f.description ?? null,
    }));
}

/** How deeply Qodo reviewed this commit ("standard", "lite", "skip"…), if it says. */
export function reviewEffort(review: QodoReview, headSha: string): string | null {
  return review.review_runs?.find((r) => r.commit_sha === headSha)?.review_effort ?? null;
}

/**
 * Every finding on the PR that Qodo hasn't marked implemented or dismissed, from any commit. A later
 * "lite" review of a new commit doesn't repeat earlier findings, so looking only at the head commit
 * can show zero while earlier ones are still open.
 */
export function openFindings(review: QodoReview): (Finding & { commit: string })[] {
  return (review.findings ?? [])
    .filter((f) => !f.dismiss_reason && f.attribution_status !== "implemented")
    .map((f) => ({ ...(findingsFor({ findings: [f] }, f.git_sha)[0] as Finding), commit: f.git_sha.slice(0, 7) }));
}

export interface WaitDeps {
  fetchReview: () => Promise<QodoReview>;
  /** Called on every poll; return the comment's `updated_at` to have new versions saved. */
  onPoll?: () => Promise<void>;
  /** Called when a poll fails; the wait goes on until the deadline. */
  onError?: (error: unknown) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type WaitResult =
  | { state: "complete" | "skipped"; review: QodoReview; polls: number; seenCompleteAt: number }
  | { state: "timeout"; review: QodoReview | undefined; polls: number };

/**
 * Polls until the review of `headSha` is complete or `timeoutMs` has passed.
 * A failed poll is reported and retried. A finished review is reported only once its comments were saved
 * after it finished. At the deadline, the last error is thrown if no poll succeeded or the final save never did.
 */
export async function waitForReview(
  headSha: string,
  deps: WaitDeps,
  { timeoutMs = 20 * 60_000, intervalMs = 20_000 } = {},
): Promise<WaitResult> {
  const deadline = deps.now() + timeoutMs;
  let review: QodoReview | undefined;
  let lastError: unknown;
  let seenCompleteAt: number | undefined;
  let polls = 0;
  const save = async () => {
    try {
      await deps.onPoll?.();
      return true;
    } catch (error) {
      lastError = error;
      deps.onError?.(error);
      return false;
    }
  };
  for (;;) {
    polls++;
    await save();
    try {
      review = await deps.fetchReview();
      const state = reviewState(review, headSha);
      if (state === "complete" || state === "skipped") {
        // Qodo gives no end time; this is when it was first seen finished, at most one interval late.
        seenCompleteAt ??= deps.now();
        // One last save: Qodo may have edited its comment between the poll and this answer.
        if (await save()) return { state, review, polls, seenCompleteAt };
      }
    } catch (error) {
      lastError = error;
      deps.onError?.(error);
    }
    if (deps.now() + intervalMs > deadline) {
      if (lastError !== undefined && (review === undefined || seenCompleteAt !== undefined)) throw lastError;
      return { state: "timeout", review, polls };
    }
    await deps.sleep(intervalMs);
  }
}

/** Runs `gh` with a time limit, so a stalled call can't keep the review timeout from firing. */
function gh(...args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", timeout: 60_000 });
}

/** Every item of a paginated list endpoint. */
function ghAll<T>(path: string, pick: (page: unknown) => T[] = (page) => page as T[]): T[] {
  return (JSON.parse(gh("api", "--paginate", "--slurp", path)) as unknown[]).flatMap(pick);
}

async function main() {
  const factory = loadFactory();
  const [repoKey, prArg, ...rest] = process.argv.slice(2);
  const timeoutIndex = rest.indexOf("--timeout");
  const timeoutMinutes = timeoutIndex >= 0 ? Number(rest[timeoutIndex + 1]) : 20;
  if (!repoKey || !prArg || !Number.isFinite(timeoutMinutes)) {
    console.error(`usage: npm run review:wait -- <${Object.keys(factory.repos).join("|")}> <pr> [--timeout minutes]`);
    process.exit(2);
  }
  const { github } = repoConfig(factory, repoKey);
  const pr = Number(prArg);
  const headSha = gh("api", `repos/${github}/pulls/${pr}`, "--jq", ".head.sha").trim();
  // GitHub has no push time; the first check suite for the commit is created when the push arrives.
  const suites = ghAll<{ created_at: string }>(
    `repos/${github}/commits/${headSha}/check-suites`,
    (p) => (p as { check_suites: { created_at: string }[] }).check_suites,
  );
  const pushSeenAt = suites.map((s) => s.created_at).sort()[0] ?? null;
  const dir = resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
    factory.evidence,
    "reviews",
    `${repoKey}-pr${pr}`,
  );
  mkdirSync(dir, { recursive: true });
  const short = headSha.slice(0, 7);
  console.log(`Waiting for Qodo's review of ${repoKey} PR ${pr} at ${short} (up to ${timeoutMinutes} min)…`);

  // Save every version of Qodo's comments while waiting: the first version can be edited later.
  let lastVersion = "";
  let lastContent = "";
  const onPoll = async () => {
    type Comment = { user: { login: string }; updated_at: string };
    const comments = {
      pr: ghAll<Comment>(`repos/${github}/issues/${pr}/comments`),
      inline: ghAll<Comment>(`repos/${github}/pulls/${pr}/comments`),
    };
    const version = [...comments.pr, ...comments.inline]
      .filter((c) => c.user.login.startsWith("qodo"))
      .map((c) => c.updated_at)
      .sort()
      .pop();
    // Compared by content: two edits in the same second share a timestamp but not their text.
    const content = JSON.stringify(comments);
    if (version && content !== lastContent) {
      lastContent = content;
      lastVersion = version;
      writeFileSync(join(dir, `${short}.comments.${version.replace(/:/g, "")}.raw.json`), JSON.stringify(comments));
    }
  };

  const api = new QodoApi();
  const result = await waitForReview(
    headSha,
    {
      fetchReview: async () => {
        try {
          return (await api.call("get-pr-review-findings", {
            pr_url: `https://github.com/${github}/pull/${pr}`,
            extended: true,
          })) as QodoReview;
        } finally {
          // Raw first: kept even when the answer can't be parsed.
          if (api.lastRaw) writeFileSync(join(dir, `${short}.qodo-api.latest.raw.json`), api.lastRaw);
        }
      },
      onPoll,
      onError: (error) =>
        console.error(`Poll failed, trying again: ${error instanceof Error ? error.message : String(error)}`),
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    { timeoutMs: timeoutMinutes * 60_000 },
  );

  if (result.review) writeFileSync(join(dir, `${short}.qodo-api.raw.json`), JSON.stringify(result.review, null, 2));
  const checks = ghAll<{ name: string; status: string; conclusion: string | null }>(
    `repos/${github}/commits/${headSha}/check-runs`,
    (p) => (p as { check_runs: { name: string; status: string; conclusion: string | null }[] }).check_runs,
  );
  const ci = checks.map((c) => `${c.name}: ${c.conclusion ?? c.status}`).join(", ") || "no checks";
  const findings = result.review ? findingsFor(result.review, headSha) : [];
  const open = result.review ? openFindings(result.review) : [];
  const effort = result.review ? reviewEffort(result.review, headSha) : null;
  const record = {
    repo: github,
    pr,
    headSha,
    state: { complete: "complete", skipped: "skipped by Qodo", timeout: "review incomplete" }[result.state],
    pushSeenAt,
    reviewEffort: effort,
    reviewSeenCompleteAt: "seenCompleteAt" in result ? new Date(result.seenCompleteAt).toISOString() : null,
    reviewSeenCompleteNote: "first poll that saw the run finished; at most one poll interval (20 s) after it finished",
    reviewStartedAt:
      result.review?.review_session?.commit_sha === headSha ? result.review.review_session.started_at : null,
    recordedAt: new Date().toISOString(),
    ci,
    abTest: { name: result.review?.ab_test_name ?? null, arm: result.review?.ab_arm ?? null },
    findings,
    openFindings: open,
  };
  writeFileSync(join(dir, `${short}.review.json`), `${JSON.stringify(record, null, 2)}\n`);

  if (result.state === "timeout") {
    console.log(`Review incomplete: no completed Qodo run for ${short} after ${timeoutMinutes} min. Saved in ${dir}`);
    process.exit(1);
  }
  if (result.state === "skipped") {
    console.log(
      `Qodo finished but skipped reviewing ${short} (review_effort: skip). Zero findings here does NOT mean clean. Saved in ${dir}`,
    );
    process.exit(3);
  }
  console.log(
    `Qodo's review of ${short} is complete (effort: ${effort ?? "not reported"}). Push seen ${pushSeenAt}, review started ${record.reviewStartedAt}.`,
  );
  console.log(`CI: ${ci}`);
  console.log(`${findings.length} finding(s) on ${short}; ${open.length} open on this PR in total:`);
  for (const f of open) {
    const where = f.file ? `${f.file}${f.lines ? `:${f.lines[0]}-${f.lines[1]}` : ""}` : "(no location)";
    console.log(`- [${f.severity}] ${f.title} (${f.category}, ${where}, raised on ${f.commit})`);
  }
  console.log(`Saved in ${dir}`);
}

// Run only when called as a script, not when the tests import it.
// Exit codes: 0 complete, 1 timed out, 2 couldn't run (usage, missing key, or every poll failed), 3 skipped.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main().catch((error: unknown) => {
    console.error(`review:wait could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}

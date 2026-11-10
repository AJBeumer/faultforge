/**
 * Waits until Qodo has really finished reviewing a PR's head commit, then saves everything.
 *
 *   npm run review:wait -- faultforge 55
 *   npm run review:wait -- target 9 --timeout 30
 *   npm run review:wait -- target 9 --commit $(git rev-parse HEAD)
 *
 * A Qodo comment is not a finished review: on Day 3 it twice said "no open findings" and was edited
 * minutes later to add findings. Only Qodo's API saying the run for the head commit is `completed`
 * counts. Read-only throughout. Exits 0 when the review is complete, 1 when it timed out (or, with
 * `--commit`, the head never became that commit or moved past it), 3 when Qodo finished the run but
 * skipped reviewing it.
 *
 * After a push, pass `--commit`: right after a push GitHub can still show the previous head, and
 * without it the previous commit's finished review would be reported as the answer (PR 65, 9 Nov).
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
  /**
   * The PR's head now. When given, a finished review counts only if the head is still `headSha`:
   * someone may have pushed again while Qodo was reviewing (PR 98).
   */
  readHead?: () => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type WaitResult =
  | { state: "complete" | "skipped"; review: QodoReview; polls: number; seenCompleteAt: number }
  | { state: "moved"; head: string; review: QodoReview; polls: number }
  | { state: "timeout"; review: QodoReview | undefined; polls: number };

/**
 * Polls until the review of `headSha` is complete or `timeoutMs` has passed.
 * A failed poll is reported and retried. A finished review is reported only once its comments were saved
 * after it finished, and, with `readHead`, only while the head is still `headSha` ("moved" otherwise).
 * At the deadline, the last error is thrown if no poll succeeded or the final save never did.
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
        if (deps.readHead) {
          const head = await deps.readHead();
          if (!sameCommit(head, headSha)) return { state: "moved", head, review, polls };
        }
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

export type HeadWaitResult =
  | {
      state: "reached" | "moved" | "timeout";
      /** The PR head at the last read: the full id of the commit waited for, or the one that stopped the wait. */
      head: string;
      polls: number;
      /** Every distinct head seen, in order. */
      seen: string[];
    }
  | { state: "failed"; head: null; polls: number; seen: []; error: string };

/** True when `head` (a full id) is the commit `target` names, in full or by a prefix of at least 7. */
export function sameCommit(head: string, target: string): boolean {
  return target.length >= 7 && head.toLowerCase().startsWith(target.toLowerCase());
}

/**
 * Polls the PR head until it is `target`. Right after a push GitHub can show the previous head for a
 * moment: on PR 65 a wait started within a second of a push reported the old commit's finished review
 * as the answer. That first head is waited out. Any other head means someone pushed again: "moved".
 * A failed read is reported and retried; if no read succeeded by the deadline, the result is "failed"
 * with the last error, so the caller can record the attempt before it stops.
 */
export async function waitForHead(
  target: string,
  deps: {
    readHead: () => Promise<string>;
    onError?: (error: unknown) => void;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  },
  { timeoutMs = 20 * 60_000, intervalMs = 5_000 } = {},
): Promise<HeadWaitResult> {
  const deadline = deps.now() + timeoutMs;
  const seen: string[] = [];
  let lastError: unknown;
  let polls = 0;
  for (;;) {
    polls++;
    try {
      const head = await deps.readHead();
      if (seen.at(-1) !== head) seen.push(head);
      if (sameCommit(head, target)) return { state: "reached", head, polls, seen };
      // The first head seen may be the stale one; a second, different one is a new push.
      if (seen.length > 1) return { state: "moved", head, polls, seen };
    } catch (error) {
      lastError = error;
      deps.onError?.(error);
    }
    if (deps.now() + intervalMs > deadline) {
      if (!seen.length) {
        const error = lastError instanceof Error ? lastError.message : String(lastError);
        return { state: "failed", head: null, polls, seen: [], error };
      }
      return { state: "timeout", head: seen.at(-1) as string, polls, seen };
    }
    await deps.sleep(intervalMs);
  }
}

export interface Args {
  repoKey: string;
  pr: number;
  timeoutMinutes: number;
  /** The commit the PR's head must be before its review counts; null to take whatever head GitHub shows. */
  commit: string | null;
}

/** The command line, or null when it's wrong. */
export function parseArgs(argv: string[]): Args | null {
  const [repoKey, prArg, ...rest] = argv;
  const option = (name: string): string | null | undefined => {
    const i = rest.indexOf(name);
    if (i < 0) return null;
    return rest[i + 1];
  };
  const timeout = option("--timeout");
  const commit = option("--commit");
  const pr = Number(prArg);
  const timeoutMinutes = timeout === null ? 20 : Number(timeout);
  if (!repoKey || !Number.isInteger(pr) || pr <= 0) return null;
  if (timeout === undefined || !Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return null;
  if (commit === undefined || (commit !== null && !/^[0-9a-f]{7,40}$/i.test(commit))) return null;
  return { repoKey, pr, timeoutMinutes, commit };
}

/**
 * Saves one poll of the two comment feeds (each the raw `gh api --paginate --slurp` text: an array of
 * pages). The raw text is written first, every poll, so an answer that can't be parsed is still kept;
 * then a new version file is written when the content changed and Qodo has commented. Returns the
 * content to compare the next poll with. Throws when a feed doesn't parse, after the raw save.
 */
export function saveCommentFeeds(
  raw: { pr: string; inline: string },
  lastContent: string,
  write: (file: string, text: string) => void,
  short: string,
): string {
  write(`${short}.comments.latest.raw.json`, JSON.stringify(raw));
  // `user` is null on a comment whose author account was deleted: substituted with "unknown" rather
  // than read as Qodo's or crashing every poll (a GitHub app's comments outlive the human accounts
  // mentioned near them, not its own, but the shape allows for it and real feeds have shown nulls).
  // A comment that does have an author keeps its full user object, not just the login: only the
  // missing case is touched.
  type Comment = { user: { login: string } | null; updated_at: string };
  const pages = (text: string) => (JSON.parse(text) as Comment[][]).flat();
  const normalize = (list: Comment[]) => list.map((c) => (c.user ? c : { ...c, user: { login: "unknown" } }));
  const comments = { pr: normalize(pages(raw.pr)), inline: normalize(pages(raw.inline)) };
  const version = [...comments.pr, ...comments.inline]
    .filter((c) => (c.user?.login ?? "unknown").startsWith("qodo"))
    .map((c) => c.updated_at)
    .sort()
    .pop();
  // Compared by content: two edits in the same second share a timestamp but not their text.
  const content = JSON.stringify(comments);
  if (!version || content === lastContent) return lastContent;
  write(`${short}.comments.${version.replace(/:/g, "")}.raw.json`, content);
  return content;
}

/** One line per check run, or "no checks" when there are none. */
export function summarizeCi(checks: { name: string; status: string; conclusion: string | null }[]): string {
  return checks.map((c) => `${c.name}: ${c.conclusion ?? c.status}`).join(", ") || "no checks";
}

/**
 * CI is optional evidence, not Qodo's answer: a failed lookup must never keep the review record
 * from being written, so this never throws. `onError` is called (not thrown) so a caller can still
 * log why, before recording "unavailable".
 */
export function ciOrUnavailable(
  fetchChecks: () => { name: string; status: string; conclusion: string | null }[],
  onError?: (error: unknown) => void,
): string {
  try {
    return summarizeCi(fetchChecks());
  } catch (error) {
    onError?.(error);
    return "unavailable";
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
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      `usage: npm run review:wait -- <${Object.keys(factory.repos).join("|")}> <pr> [--commit <sha>] [--timeout minutes]`,
    );
    process.exit(2);
  }
  const { repoKey, pr, timeoutMinutes, commit } = args;
  const { github } = repoConfig(factory, repoKey);
  const deadline = Date.now() + timeoutMinutes * 60_000;
  const dir = resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
    factory.evidence,
    "reviews",
    `${repoKey}-pr${pr}`,
  );
  const readHead = async () => gh("api", `repos/${github}/pulls/${pr}`, "--jq", ".head.sha").trim();
  let headSha: string;
  if (commit === null) headSha = await readHead();
  else {
    console.log(`Waiting for ${repoKey} PR ${pr} to show ${commit.slice(0, 7)} as its head…`);
    const head = await waitForHead(
      commit,
      {
        readHead,
        onError: (error) =>
          console.error(
            `Reading the PR head failed, trying again: ${error instanceof Error ? error.message : String(error)}`,
          ),
        now: Date.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      { timeoutMs: timeoutMinutes * 60_000 },
    );
    // Saved whatever the outcome, so a stopped wait shows which heads it saw and when it gave up.
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${commit.slice(0, 7)}.head-wait.json`),
      `${JSON.stringify({ repo: github, pr, commit, ...head, recordedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    // Every read failed: not a review result, so exit 2 like any other run that couldn't reach GitHub.
    if (head.state === "failed") throw new Error(`reading the PR head failed on every poll: ${head.error}`);
    if (head.state !== "reached") {
      console.log(
        head.state === "moved"
          ? `The PR head moved to ${head.head.slice(0, 7)} while waiting for ${commit.slice(0, 7)}: not reviewing a commit nobody asked for.`
          : `The PR head is still ${head.head.slice(0, 7)} after ${timeoutMinutes} min; it never became ${commit.slice(0, 7)}.`,
      );
      process.exit(1);
    }
    headSha = head.head;
  }
  // GitHub has no push time; the first check suite for the commit is created when the push arrives.
  const suites = ghAll<{ created_at: string }>(
    `repos/${github}/commits/${headSha}/check-suites`,
    (p) => (p as { check_suites: { created_at: string }[] }).check_suites,
  );
  const pushSeenAt = suites.map((s) => s.created_at).sort()[0] ?? null;
  mkdirSync(dir, { recursive: true });
  const short = headSha.slice(0, 7);
  console.log(`Waiting for Qodo's review of ${repoKey} PR ${pr} at ${short} (up to ${timeoutMinutes} min)…`);

  // Save every version of Qodo's comments while waiting: the first version can be edited later.
  let lastContent = "";
  const onPoll = async () => {
    const raw = {
      pr: gh("api", "--paginate", "--slurp", `repos/${github}/issues/${pr}/comments`),
      inline: gh("api", "--paginate", "--slurp", `repos/${github}/pulls/${pr}/comments`),
    };
    lastContent = saveCommentFeeds(raw, lastContent, (file, text) => writeFileSync(join(dir, file), text), short);
    // `pulls/{n}/reviews` (a formal GitHub review, approve/request-changes) isn't where Qodo's
    // comments live, but it's saved on every poll too: a bounded endpoint list is only trustworthy
    // while every endpoint that could hold the data is actually read, not assumed empty.
    writeFileSync(
      join(dir, `${short}.reviews.latest.raw.json`),
      gh("api", "--paginate", "--slurp", `repos/${github}/pulls/${pr}/reviews`),
    );
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
          // A session recovery's own answer overwrites lastRaw; the failure that caused it is saved
          // separately so it isn't lost.
          if (api.lastRecoveredRaw.length) {
            writeFileSync(
              join(dir, `${short}.qodo-api.latest.recovered.raw.json`),
              JSON.stringify(api.lastRecoveredRaw),
            );
          }
          // Raw first: kept even when the answer can't be parsed.
          if (api.lastRaw) writeFileSync(join(dir, `${short}.qodo-api.latest.raw.json`), api.lastRaw);
        }
      },
      onPoll,
      onError: (error) =>
        console.error(`Poll failed, trying again: ${error instanceof Error ? error.message : String(error)}`),
      // With --commit, a finished review counts only if nobody pushed again meanwhile.
      readHead: commit === null ? undefined : readHead,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    // One time budget for the whole run: waiting for the head used part of it.
    { timeoutMs: Math.max(deadline - Date.now(), 0) },
  );

  if (result.review) writeFileSync(join(dir, `${short}.qodo-api.raw.json`), JSON.stringify(result.review, null, 2));
  const findings = result.review ? findingsFor(result.review, headSha) : [];
  const open = result.review ? openFindings(result.review) : [];
  const effort = result.review ? reviewEffort(result.review, headSha) : null;
  // CI is optional evidence about the same commit, not part of Qodo's answer: computed safely so a
  // failed lookup can never cost the review record below, which is written only once, complete.
  const ci = ciOrUnavailable(
    () =>
      ghAll<{ name: string; status: string; conclusion: string | null }>(
        `repos/${github}/commits/${headSha}/check-runs`,
        (p) => (p as { check_runs: { name: string; status: string; conclusion: string | null }[] }).check_runs,
      ),
    (error) =>
      console.error(
        `CI check-runs lookup failed, recording ci as unavailable: ${error instanceof Error ? error.message : String(error)}`,
      ),
  );
  const record = {
    repo: github,
    pr,
    headSha,
    state: {
      complete: "complete",
      skipped: "skipped by Qodo",
      timeout: "review incomplete",
      moved: "head moved during the review",
    }[result.state],
    headMovedTo: result.state === "moved" ? result.head : null,
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
  if (result.state === "moved") {
    console.log(
      `Qodo's review of ${short} finished, but the PR head is now ${result.head.slice(0, 7)}: not reporting a review of a commit that is no longer the head. Saved in ${dir}`,
    );
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
  console.log(`CI: ${record.ci}`);
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

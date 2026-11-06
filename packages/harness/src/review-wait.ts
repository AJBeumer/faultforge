/**
 * Waits until Qodo has really finished reviewing a PR's head commit, then saves everything.
 *
 *   npm run review:wait -- faultforge 55
 *   npm run review:wait -- target 9 --timeout 30
 *
 * A Qodo comment is not a finished review: on Day 3 it twice said "no open findings" and was edited
 * minutes later to add findings. Only Qodo's API saying the run for the head commit is `completed`
 * counts. Read-only throughout. Exits 0 when the review is complete, 1 when it timed out.
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

/** "complete" only when the run for exactly this commit is completed. */
export function reviewState(review: QodoReview, headSha: string): "complete" | "running" | "not-started" {
  const session = review.review_session;
  if (!session || session.commit_sha !== headSha) return "not-started";
  return session.status === "completed" && session.review_complete ? "complete" : "running";
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

export interface WaitDeps {
  fetchReview: () => Promise<QodoReview>;
  /** Called on every poll; return the comment's `updated_at` to have new versions saved. */
  onPoll?: () => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type WaitResult =
  | { state: "complete"; review: QodoReview; polls: number }
  | { state: "timeout"; review: QodoReview | undefined; polls: number };

/** Polls until the review of `headSha` is complete or `timeoutMs` has passed. */
export async function waitForReview(
  headSha: string,
  deps: WaitDeps,
  { timeoutMs = 20 * 60_000, intervalMs = 20_000 } = {},
): Promise<WaitResult> {
  const deadline = deps.now() + timeoutMs;
  let review: QodoReview | undefined;
  let polls = 0;
  for (;;) {
    polls++;
    await deps.onPoll?.();
    review = await deps.fetchReview();
    if (reviewState(review, headSha) === "complete") return { state: "complete", review, polls };
    if (deps.now() + intervalMs > deadline) return { state: "timeout", review, polls };
    await deps.sleep(intervalMs);
  }
}

function gh(...args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8" });
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
  const pushedAt = gh("api", `repos/${github}/commits/${headSha}`, "--jq", ".commit.committer.date").trim();
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
  const onPoll = async () => {
    const comments = gh("api", `repos/${github}/issues/${pr}/comments`);
    const version = (JSON.parse(comments) as { user: { login: string }; updated_at: string }[])
      .filter((c) => c.user.login.startsWith("qodo"))
      .map((c) => c.updated_at)
      .sort()
      .pop();
    if (version && version !== lastVersion) {
      lastVersion = version;
      writeFileSync(join(dir, `${short}.comments.${version.replace(/:/g, "")}.raw.json`), comments);
    }
  };

  const api = new QodoApi();
  const result = await waitForReview(
    headSha,
    {
      fetchReview: async () => {
        const review = (await api.call("get-pr-review-findings", {
          pr_url: `https://github.com/${github}/pull/${pr}`,
          extended: true,
        })) as QodoReview;
        return review;
      },
      onPoll,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    { timeoutMs: timeoutMinutes * 60_000 },
  );

  if (result.review) writeFileSync(join(dir, `${short}.qodo-api.raw.json`), JSON.stringify(result.review, null, 2));
  const checks = JSON.parse(gh("api", `repos/${github}/commits/${headSha}/check-runs`)).check_runs as {
    name: string;
    status: string;
    conclusion: string | null;
  }[];
  const ci = checks.map((c) => `${c.name}: ${c.conclusion ?? c.status}`).join(", ") || "no checks";
  const findings = result.review ? findingsFor(result.review, headSha) : [];
  const record = {
    repo: github,
    pr,
    headSha,
    state: result.state === "complete" ? "complete" : "review incomplete",
    pushedAt,
    reviewStartedAt:
      result.review?.review_session?.commit_sha === headSha ? result.review.review_session.started_at : null,
    recordedAt: new Date().toISOString(),
    ci,
    abTest: { name: result.review?.ab_test_name ?? null, arm: result.review?.ab_arm ?? null },
    findings,
  };
  writeFileSync(join(dir, `${short}.review.json`), `${JSON.stringify(record, null, 2)}\n`);

  if (result.state === "timeout") {
    console.log(`Review incomplete: no completed Qodo run for ${short} after ${timeoutMinutes} min. Saved in ${dir}`);
    process.exit(1);
  }
  console.log(`Qodo's review of ${short} is complete. Pushed ${pushedAt}, review started ${record.reviewStartedAt}.`);
  console.log(`CI: ${ci}`);
  console.log(`${findings.length} finding(s):`);
  for (const f of findings) {
    const where = f.file ? `${f.file}${f.lines ? `:${f.lines[0]}-${f.lines[1]}` : ""}` : "(no location)";
    console.log(`- [${f.severity}] ${f.title} (${f.category}, ${where})`);
  }
  console.log(`Saved in ${dir}`);
}

// Run only when called as a script, not when the tests import it.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();

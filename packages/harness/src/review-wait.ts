/**
 * Waits until Qodo has really finished reviewing a PR's head commit, then saves everything.
 *
 *   npm run review:wait -- faultforge 55
 *   npm run review:wait -- target 9 --timeout 30
 *   npm run review:wait -- target 9 --commit $(git rev-parse HEAD)
 *
 * A Qodo comment is not a finished review: on Day 3 it twice said "no open findings" and was edited
 * minutes later to add findings. Only Qodo's API saying the run for the head commit is `completed`
 * counts. Read-only throughout.
 *
 * Exit codes: 0 Qodo's review of the head (with `--commit`, of that commit) is complete; 1 there is no
 * complete review of it within the time limit, whether Qodo didn't finish, its API answered on every poll but
 * never with a review, or, with `--commit`, the head never became that commit or moved past it; 2 it couldn't run (usage, a missing key, or every poll
 * failed); 3 Qodo finished the run but skipped reviewing it.
 *
 * After a push, pass `--commit`: right after a push GitHub can still show the previous head, and
 * without it the previous commit's finished review would be reported as the answer (PR 65, 9 Nov).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { loadFactory, repoConfig } from "./factory-config.ts";
import { gh, ghAll } from "./github.ts";
import { ROOT } from "./paths.ts";
import { QodoApi } from "./qodo-api.ts";
import { findingsFor, findingsShapeProblem, openFindings, type QodoReview, reviewEffort } from "./qodo-review.ts";
import { ciOrUnavailable, saveCommentFeeds } from "./review-feeds.ts";
import { waitForHead, waitForReview } from "./review-poll.ts";

export interface Args {
  repoKey: string;
  pr: number;
  timeoutMinutes: number;
  /** The commit the PR's head must be before its review counts; null to take whatever head GitHub shows. */
  commit: string | null;
}

/** The command line, or null when it's wrong. */
export function parseArgs(argv: string[]): Args | null {
  let values: { commit?: string; timeout?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseNodeArgs({
      args: argv,
      options: { commit: { type: "string" }, timeout: { type: "string" } },
      allowPositionals: true,
    }));
  } catch {
    return null;
  }
  const [repoKey, prArg] = positionals;
  const pr = Number(prArg);
  const timeoutMinutes = values.timeout === undefined ? 20 : Number(values.timeout);
  const commit = values.commit ?? null;
  if (!repoKey || !Number.isInteger(pr) || pr <= 0) return null;
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return null;
  if (commit !== null && !/^[0-9a-f]{7,40}$/i.test(commit)) return null;
  return { repoKey, pr, timeoutMinutes, commit };
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
  const dir = resolve(ROOT, factory.evidence, "reviews", `${repoKey}-pr${pr}`);
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
    // while every endpoint that could hold the data is actually read, not assumed empty. It's purely
    // supplementary, so a failure here is logged and skipped, never allowed to fail the whole poll:
    // `waitForReview` requires `onPoll` to succeed before it will report a review complete, and this
    // endpoint isn't worth losing that over.
    try {
      writeFileSync(
        join(dir, `${short}.reviews.latest.raw.json`),
        gh("api", "--paginate", "--slurp", `repos/${github}/pulls/${pr}/reviews`),
      );
    } catch (error) {
      console.error(
        `pulls/{n}/reviews lookup failed, continuing without it: ${error instanceof Error ? error.message : String(error)}`,
      );
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
  // Checked after the raw answer is saved and before any record is written: a complete review in a shape
  // this can't read is a failure to read, exit 2, never zero findings.
  const shape = result.state === "complete" && result.review ? findingsShapeProblem(result.review) : undefined;
  if (shape) throw new Error(`${shape}; the raw answer is saved in ${dir}`);
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
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main().catch((error: unknown) => {
    console.error(`review:wait could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}

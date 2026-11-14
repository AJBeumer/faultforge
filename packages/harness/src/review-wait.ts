/**
 * Waits until Qodo has really finished reviewing a PR's head commit, then saves everything.
 *
 *   npm run review:wait -- faultforge 55
 *   npm run review:wait -- target 9 --timeout 30
 *   npm run review:wait -- target 9 --commit $(git rev-parse HEAD)
 *
 * A Qodo comment is not a finished review: on Day 3 it twice said "no open findings" and was edited
 * minutes later to add findings. Only Qodo's API saying the run for the head commit is `completed`
 * counts. Read-only towards GitHub and Qodo throughout.
 *
 * The save (`<evidence>/reviews/<repo>-pr<N>/<sha7>.review.json`, from `saved-review.ts`) is never written
 * over: a verdict's hash covers it. When a complete save of the commit exists, nothing is waited for or
 * written. An unfinished one (timed out, skipped, head moved) may be waited for again; it is kept, renamed
 * `<sha7>.unfinished-<n>.json`, when the new save is written.
 *
 * Exit codes: 0 Qodo's review of the head (with `--commit`, of that commit) is complete and saved; 1 there
 * is no complete review of it within the time limit, whether Qodo didn't finish or, with `--commit`, the head
 * never became that commit or moved past it (what was seen is saved); 2 it couldn't run: usage, a missing
 * key, every poll failed or answered something that isn't a review, a complete review in a shape this can't
 * read, or a complete save of this commit that already exists; 3 Qodo finished the run but skipped reviewing it.
 *
 * After a push, pass `--commit`: right after a push GitHub can still show the previous head, and
 * without it the previous commit's finished review would be reported as the answer (PR 65, 9 Nov).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { errorText as message } from "./error-text.ts";
import { loadFactory, repoConfig } from "./factory-config.ts";
import { gh, ghAll } from "./github.ts";
import { QodoApi } from "./qodo-api.ts";
import { findingsFor, findingsShapeProblem, openFindings, type QodoReview, reviewEffort } from "./qodo-review.ts";
import { ciOrUnavailable, saveCommentFeeds } from "./review-feeds.ts";
import { waitForHead, waitForReview } from "./review-poll.ts";
import { savedReviewDir, savedReviewPath, savedReviewRefusal, writeSavedReview } from "./saved-review.ts";

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

/** Everything `run` reads or waits on, passed in so the tests drive it without GitHub, Qodo or a clock. */
export interface WaitScriptDeps {
  /** `owner/repo` of the PR. */
  github: string;
  /** The PR's saves folder. */
  dir: string;
  readHead: () => Promise<string>;
  /** When each check suite for a commit was created: the first is when GitHub saw the push. */
  checkSuiteTimes: (sha: string) => string[];
  /** The two comment feeds, raw (`gh api --paginate --slurp`). */
  commentFeeds: () => { pr: string; inline: string };
  /** The formal GitHub reviews, raw. Supplementary: a failure is logged and skipped. */
  formalReviews: () => string;
  /** Qodo's `get-pr-review-findings` answer for the PR. */
  fetchReview: () => Promise<unknown>;
  /** The raw text of Qodo's last answer, and of any answers a session recovery replaced. */
  rawAnswers: () => { last: string; recovered: string[] };
  checkRuns: (sha: string) => { name: string; status: string; conclusion: string | null }[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** The saved state for each way a wait ends. Only a complete review is ever saved as "complete". */
export const SAVED_STATE = {
  complete: "complete",
  skipped: "skipped by Qodo",
  timeout: "review incomplete",
  moved: "head moved during the review",
} as const;

/** Runs one wait and returns its exit code (see the header); every failure is caught and is exit 2. */
export async function run(args: Args, deps: WaitScriptDeps): Promise<number> {
  try {
    return await wait(args, deps);
  } catch (e) {
    deps.error(`review:wait could not run: ${message(e)}`);
    return 2;
  }
}

async function wait({ repoKey, pr, timeoutMinutes, commit }: Args, deps: WaitScriptDeps): Promise<number> {
  const { dir, github, log } = deps;
  const deadline = deps.now() + timeoutMinutes * 60_000;
  // A complete save is never overwritten (AUD-M26): refused before any waiting once the commit is known. An
  // unfinished one may be waited for again, and is kept under another name (Qodo on PR 264).
  const refuseExisting = (sha: string) => {
    const refusal = savedReviewRefusal(savedReviewPath(dir, sha.toLowerCase()));
    if (refusal) throw new Error(refusal);
  };
  let headSha: string;
  if (commit === null) {
    headSha = await deps.readHead();
    refuseExisting(headSha);
  } else {
    refuseExisting(commit);
    log(`Waiting for ${repoKey} PR ${pr} to show ${commit.slice(0, 7)} as its head…`);
    const head = await waitForHead(
      commit,
      {
        readHead: deps.readHead,
        onError: (e) => deps.error(`Reading the PR head failed, trying again: ${message(e)}`),
        now: deps.now,
        sleep: deps.sleep,
      },
      { timeoutMs: timeoutMinutes * 60_000 },
    );
    // Saved whatever the outcome, so a stopped wait shows which heads it saw and when it gave up.
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${commit.slice(0, 7)}.head-wait.json`),
      `${JSON.stringify({ repo: github, pr, commit, ...head, recordedAt: new Date(deps.now()).toISOString() }, null, 2)}\n`,
    );
    // Every read failed: not a review result, so exit 2 like any other run that couldn't reach GitHub.
    if (head.state === "failed") throw new Error(`reading the PR head failed on every poll: ${head.error}`);
    if (head.state !== "reached") {
      log(
        head.state === "moved"
          ? `The PR head moved to ${head.head.slice(0, 7)} while waiting for ${commit.slice(0, 7)}: not reviewing a commit nobody asked for.`
          : `The PR head is still ${head.head.slice(0, 7)} after ${timeoutMinutes} min; it never became ${commit.slice(0, 7)}.`,
      );
      return 1;
    }
    headSha = head.head;
    refuseExisting(headSha);
  }
  // GitHub has no push time; the first check suite for the commit is created when the push arrives.
  const pushSeenAt = deps.checkSuiteTimes(headSha).sort()[0] ?? null;
  mkdirSync(dir, { recursive: true });
  const short = headSha.slice(0, 7);
  log(`Waiting for Qodo's review of ${repoKey} PR ${pr} at ${short} (up to ${timeoutMinutes} min)…`);

  // Save every version of Qodo's comments while waiting: the first version can be edited later.
  let lastContent = "";
  const onPoll = async () => {
    lastContent = saveCommentFeeds(deps.commentFeeds(), lastContent, (f, t) => writeFileSync(join(dir, f), t), short);
    // `pulls/{n}/reviews` isn't where Qodo's comments live, but it's saved on every poll too: a bounded
    // endpoint list is only trustworthy while every endpoint that could hold the data is actually read.
    // It's supplementary, so a failure here is logged and never fails the poll.
    try {
      writeFileSync(join(dir, `${short}.reviews.latest.raw.json`), deps.formalReviews());
    } catch (e) {
      deps.error(`pulls/{n}/reviews lookup failed, continuing without it: ${message(e)}`);
    }
  };

  const result = await waitForReview(
    headSha,
    {
      fetchReview: async () => {
        let answer: unknown;
        try {
          answer = await deps.fetchReview();
        } finally {
          // Raw first: kept even when the answer can't be parsed. A session recovery's own answer
          // overwrites the last one, so the failure that caused it is saved separately.
          const raw = deps.rawAnswers();
          if (raw.recovered.length) {
            writeFileSync(join(dir, `${short}.qodo-api.latest.recovered.raw.json`), JSON.stringify(raw.recovered));
          }
          if (raw.last) writeFileSync(join(dir, `${short}.qodo-api.latest.raw.json`), raw.last);
        }
        // `null` or text is not a review: a failed poll, never a review still running (C-15).
        if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
          throw new Error(`Qodo answered ${JSON.stringify(answer)?.slice(0, 80)}, not a review`);
        }
        return answer as QodoReview;
      },
      onPoll,
      onError: (e) => deps.error(`Poll failed, trying again: ${message(e)}`),
      // With --commit, a finished review counts only if nobody pushed again meanwhile.
      readHead: commit === null ? undefined : deps.readHead,
      now: deps.now,
      sleep: deps.sleep,
    },
    // One time budget for the whole run: waiting for the head used part of it.
    { timeoutMs: Math.max(deadline - deps.now(), 0) },
  );

  if (result.review) writeFileSync(join(dir, `${short}.qodo-api.raw.json`), JSON.stringify(result.review, null, 2));
  // Checked after the raw answer is saved and before any record is written: a complete review in a shape
  // this can't read is a failure to read, exit 2, never zero findings.
  const shape = result.state === "complete" && result.review ? findingsShapeProblem(result.review, headSha) : undefined;
  if (shape) throw new Error(`${shape}; the raw answer is saved in ${dir}`);
  const findings = result.review ? findingsFor(result.review, headSha) : [];
  const open = result.review ? openFindings(result.review) : [];
  const effort = result.review ? reviewEffort(result.review, headSha) : null;
  // CI is optional evidence about the same commit: computed safely so a failed lookup never costs the save.
  const ci = ciOrUnavailable(
    () => deps.checkRuns(headSha),
    (e) => deps.error(`CI check-runs lookup failed, recording ci as unavailable: ${message(e)}`),
  );
  const record = {
    repo: github,
    pr,
    headSha,
    state: SAVED_STATE[result.state],
    headMovedTo: result.state === "moved" ? result.head : null,
    pushSeenAt,
    reviewEffort: effort,
    reviewSeenCompleteAt: "seenCompleteAt" in result ? new Date(result.seenCompleteAt).toISOString() : null,
    reviewSeenCompleteNote: "first poll that saw the run finished; at most one poll interval (20 s) after it finished",
    reviewStartedAt:
      result.review?.review_session?.commit_sha === headSha ? result.review.review_session.started_at : null,
    recordedAt: new Date(deps.now()).toISOString(),
    ci,
    abTest: { name: result.review?.ab_test_name ?? null, arm: result.review?.ab_arm ?? null },
    findings,
    openFindings: open,
  };
  writeSavedReview(savedReviewPath(dir, headSha), record);

  if (result.state === "timeout") {
    log(`Review incomplete: no completed Qodo run for ${short} after ${timeoutMinutes} min. Saved in ${dir}`);
    return 1;
  }
  if (result.state === "moved") {
    log(
      `Qodo's review of ${short} finished, but the PR head is now ${result.head.slice(0, 7)}: not reporting a review of a commit that is no longer the head. Saved in ${dir}`,
    );
    return 1;
  }
  if (result.state === "skipped") {
    log(
      `Qodo finished but skipped reviewing ${short} (review_effort: skip). Zero findings here does NOT mean clean. Saved in ${dir}`,
    );
    return 3;
  }
  log(
    `Qodo's review of ${short} is complete (effort: ${effort ?? "not reported"}). Push seen ${pushSeenAt}, review started ${record.reviewStartedAt}.`,
  );
  log(`CI: ${record.ci}`);
  log(`${findings.length} finding(s) on ${short}; ${open.length} open on this PR in total:`);
  for (const f of open) {
    const where = f.file ? `${f.file}${f.lines ? `:${f.lines[0]}-${f.lines[1]}` : ""}` : "(no location)";
    log(`- [${f.severity}] ${f.title} (${f.category}, ${where}, raised on ${f.commit})`);
  }
  log(`Saved in ${dir}`);
  return 0;
}

/** The real GitHub, Qodo and clock behind `run`. */
export function liveDeps(repoKey: string, pr: number): WaitScriptDeps {
  const { github } = repoConfig(loadFactory(), repoKey);
  const api = new QodoApi();
  return {
    github,
    dir: savedReviewDir(repoKey, pr),
    readHead: async () => gh("api", `repos/${github}/pulls/${pr}`, "--jq", ".head.sha").trim(),
    checkSuiteTimes: (sha) =>
      ghAll<{ created_at: string }>(
        `repos/${github}/commits/${sha}/check-suites`,
        (p) => (p as { check_suites: { created_at: string }[] }).check_suites,
      ).map((s) => s.created_at),
    commentFeeds: () => ({
      pr: gh("api", "--paginate", "--slurp", `repos/${github}/issues/${pr}/comments`),
      inline: gh("api", "--paginate", "--slurp", `repos/${github}/pulls/${pr}/comments`),
    }),
    formalReviews: () => gh("api", "--paginate", "--slurp", `repos/${github}/pulls/${pr}/reviews`),
    fetchReview: () =>
      api.call("get-pr-review-findings", { pr_url: `https://github.com/${github}/pull/${pr}`, extended: true }),
    rawAnswers: () => ({ last: api.lastRaw, recovered: api.lastRecoveredRaw }),
    checkRuns: (sha) =>
      ghAll<{ name: string; status: string; conclusion: string | null }>(
        `repos/${github}/commits/${sha}/check-runs`,
        (p) => (p as { check_runs: { name: string; status: string; conclusion: string | null }[] }).check_runs,
      ),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

// Run only when called as a script, not when the tests import it.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(
      `usage: npm run review:wait -- <${Object.keys(loadFactory().repos).join("|")}> <pr> [--commit <sha>] [--timeout minutes]`,
    );
    process.exit(2);
  }
  let deps: WaitScriptDeps;
  try {
    deps = liveDeps(args.repoKey, args.pr);
  } catch (e) {
    console.error(`review:wait could not run: ${message(e)}`);
    process.exit(2);
  }
  process.exit(await run(args, deps));
}

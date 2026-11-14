/**
 * Records a case's review in the audit log from what `review:wait` saved, so `case:build` has its review
 * stage without an event written by hand (#162).
 *
 *   npm run case:review -- FF-0006
 *   npm run case:review -- FF-0006 --dry-run      # prints the event, writes nothing
 *
 * Reads the case's answer-key entry for the injected commit, the `review:wait` save of that commit (its
 * `*.review.json`), and the comment feed saved beside it, where Qodo's "Code Review by Qodo" comment gives
 * the review's URL and time. The configuration version comes from the case's `pr.opened` event. Appends one
 * `review.recorded` event with `pr`, `reviewer`, `path`, `configVersion`, `reviewedCommit`, `reviewedAt` and
 * `url`. A review that didn't finish is recorded too, with its state: an inconclusive case needs its review
 * stage like any other.
 *
 * Exit codes: 0 the event was appended (or printed with `--dry-run`); 1 the case already has a
 * `review.recorded` event, so nothing was written (the log is append-only; correct one with an amendment);
 * 2 nothing was written, because an input is missing or unreadable, the answer key or audit log has an
 * amendment or history problem, the save is for another commit, or the saved feed holds no review comment from Qodo.
 *
 * An unexpected error, even while loading, is 2 too: `npm run case:review` runs `case-review-cli.ts`.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { errorText as message } from "./error-text.ts";
import { readAuditLog, readLedger } from "./ledger.ts";
import { appendEvent } from "./ledger-append.ts";
import { ledgerProblemsWithHistory } from "./ledger-check.ts";
import { TOOL } from "./provenance.ts";
import { findSavedReview, prNumberOf, savedReviewsDir } from "./saved-review.ts";

import { privateDir } from "./templates.ts";

const REVIEWER = "qodo-code-review[bot]";

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  dryRun?: boolean;
  now?: () => string;
  groundTruthPath?: string;
  auditEventsPath?: string;
  reviewsDir?: string;
}

/**
 * Qodo's review comment in a saved `comments.latest.raw.json`: its URL and when it was last updated. Qodo
 * rewrites its comment in place after every push, so only a version updated at or after `since` (the push
 * `review:wait` saw) can be this commit's review (Qodo on PR 214).
 */
export function qodoReviewComment(
  savedFeeds: string,
  since?: string | null,
): { url: string; updatedAt: string } | undefined {
  const feeds = JSON.parse(savedFeeds) as { pr?: string };
  const pages = JSON.parse(feeds.pr ?? "[]") as unknown[];
  const comments = pages.flat() as {
    user?: { login?: string } | null;
    body?: string;
    html_url?: string;
    updated_at?: string;
  }[];
  const review = comments
    .filter((c) => c.user?.login === REVIEWER && /Code Review by Qodo/.test(c.body ?? ""))
    // Compared as instants, never as truncated text: a comment from the push's own second may predate it.
    .filter((c) => !since || Date.parse(c.updated_at ?? "") >= Date.parse(since))
    .pop();
  return review?.html_url && review.updated_at ? { url: review.html_url, updatedAt: review.updated_at } : undefined;
}

export function run(caseId: string, options: RunOptions = {}): number {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const root = privateDir(env);
  const groundTruthPath = options.groundTruthPath ?? join(root, "ground-truth.jsonl");
  const auditEventsPath = options.auditEventsPath ?? join(root, "audit-events.jsonl");
  const reviewsDir = options.reviewsDir ?? savedReviewsDir(env);

  try {
    const problems = ledgerProblemsWithHistory([groundTruthPath, auditEventsPath]);
    if (problems.length) {
      error(`case:review: the answer key or audit log has problems:\n${problems.map((p) => `- ${p}`).join("\n")}`);
      return 2;
    }
    const entry = readLedger(groundTruthPath).find((e) => e.caseId === caseId);
    if (!entry || typeof entry.injectionCommit !== "string") {
      error(`case:review: no answer-key entry with an injection commit for ${caseId}`);
      return 2;
    }
    const events = readAuditLog(auditEventsPath).filter((e) => e.caseId === caseId);
    if (events.some((e) => e.type === "review.recorded")) {
      log(`case:review: ${caseId} already has a review.recorded event; nothing written`);
      return 1;
    }
    const opened = events.filter((e) => e.type === "pr.opened").pop();
    const configVersion = opened?.qodoConfiguration;
    if (typeof configVersion !== "string") {
      error(`case:review: ${caseId} has no pr.opened event naming its Qodo configuration`);
      return 2;
    }

    // The save must be for the case's own PR: read from pr.opened however it was written, and passed to the
    // search so another PR's save of the same commit is never picked first (Qodo on PR 214).
    const casePr = prNumberOf(opened?.pr);
    if (casePr === undefined) {
      error(`case:review: ${caseId}'s pr.opened event names no PR (${JSON.stringify(opened?.pr)})`);
      return 2;
    }
    const found = findSavedReview(reviewsDir, entry.injectionCommit, casePr);
    if (!found) {
      error(
        `case:review: no review:wait save for ${entry.injectionCommit} on PR ${casePr} under ${reviewsDir}; run review:wait first`,
      );
      return 2;
    }
    const save = found.review as unknown as {
      repo?: string;
      pr?: number;
      headSha?: string;
      state?: string;
      pushSeenAt?: string | null;
      recordedAt?: string;
    };
    if (save.headSha !== entry.injectionCommit) {
      error(`case:review: ${found.path} reviewed ${save.headSha}, not ${caseId}'s injected commit`);
      return 2;
    }
    const short = entry.injectionCommit.slice(0, 7);
    const feedsPath = join(dirname(found.path), `${short}.comments.latest.raw.json`);
    // A review that never finished may have no review comment, or no saved feed at all when every poll of it
    // failed; its stage is still recorded, pointing at the PR and the time review:wait gave up, so an
    // inconclusive record can be built (Qodo on PR 214). A complete review must have its feed.
    const unfinished = save.state !== "complete";
    const comment =
      unfinished && !existsSync(feedsPath)
        ? undefined
        : qodoReviewComment(readFileSync(feedsPath, "utf8"), save.pushSeenAt);
    const prUrl = `https://github.com/${save.repo}/pull/${save.pr}`;
    const where = comment ?? (unfinished && save.recordedAt ? { url: prUrl, updatedAt: save.recordedAt } : undefined);
    if (!where) {
      error(`case:review: the saved comment feed holds no review comment from Qodo for ${short}`);
      return 2;
    }

    const event = {
      eventId: randomUUID(),
      type: "review.recorded",
      at: (options.now ?? (() => new Date().toISOString()))(),
      caseId,
      tool: TOOL,
      environment: `${platform()}-${arch()}-node${process.versions.node}`,
      pr: { repo: save.repo, number: save.pr, url: `https://github.com/${save.repo}/pull/${save.pr}` },
      review: {
        reviewer: REVIEWER,
        path: "pr-comments",
        configVersion,
        reviewedCommit: entry.injectionCommit,
        reviewedAt: where.updatedAt,
        url: where.url,
      },
      state: save.state ?? null,
    };
    if (options.dryRun) {
      log(`(dry run) would append to ${auditEventsPath}:`);
      log(JSON.stringify(event, null, 2));
      return 0;
    }
    appendEvent(auditEventsPath, event);
    log(`recorded: ${caseId} review of ${short} (${save.state ?? "state not saved"}), ${where.url}`);
    return 0;
  } catch (e) {
    error(`case:review: ${message(e)}`);
    return 2;
  }
}

/** The command: `case-review-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(args: string[]): number {
  const caseId = args.find((a) => !a.startsWith("--"));
  if (!caseId || !/^FF-\d{4}$/.test(caseId)) {
    console.error("usage: npm run case:review -- <FF-NNNN> [--dry-run]");
    return 2;
  }
  return run(caseId, { dryRun: args.includes("--dry-run") });
}

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
 * amendment problem, the save is for another commit, or the saved feed holds no review comment from Qodo.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerProblemsIn, readAuditLog, readLedger } from "./ledger.ts";
import { ROOT } from "./paths.ts";
import { privateDir } from "./templates.ts";
import { findSavedReview } from "./verdict.ts";

const TOOL = `faultforge-harness@${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version}`;
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

/** Qodo's review comment in a saved `comments.latest.raw.json`: its URL and when it was last updated. */
export function qodoReviewComment(savedFeeds: string): { url: string; updatedAt: string } | undefined {
  const feeds = JSON.parse(savedFeeds) as { pr?: string };
  const pages = JSON.parse(feeds.pr ?? "[]") as unknown[];
  const comments = pages.flat() as {
    user?: { login?: string } | null;
    body?: string;
    html_url?: string;
    updated_at?: string;
  }[];
  const review = comments.filter((c) => c.user?.login === REVIEWER && /Code Review by Qodo/.test(c.body ?? "")).pop();
  return review?.html_url && review.updated_at ? { url: review.html_url, updatedAt: review.updated_at } : undefined;
}

export function run(caseId: string, options: RunOptions = {}): number {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const root = privateDir(env);
  const groundTruthPath = options.groundTruthPath ?? join(root, "ground-truth.jsonl");
  const auditEventsPath = options.auditEventsPath ?? join(root, "audit-events.jsonl");
  const reviewsDir = options.reviewsDir ?? join(root, "raw-artifacts", "reviews");

  try {
    const problems = ledgerProblemsIn([groundTruthPath, auditEventsPath]);
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

    const found = findSavedReview(reviewsDir, entry.injectionCommit);
    if (!found) {
      error(`case:review: no review:wait save for ${entry.injectionCommit} under ${reviewsDir}; run review:wait first`);
      return 2;
    }
    const save = found.review as unknown as { repo?: string; pr?: number; headSha?: string; state?: string };
    if (save.headSha !== entry.injectionCommit) {
      error(`case:review: ${found.path} reviewed ${save.headSha}, not ${caseId}'s injected commit`);
      return 2;
    }
    if (typeof opened?.pr === "number" && opened.pr !== save.pr) {
      error(`case:review: the save is for PR ${save.pr}, but ${caseId}'s pr.opened event names PR ${opened.pr}`);
      return 2;
    }
    const short = entry.injectionCommit.slice(0, 7);
    const comment = qodoReviewComment(
      readFileSync(join(dirname(found.path), `${short}.comments.latest.raw.json`), "utf8"),
    );
    if (!comment) {
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
        reviewedAt: comment.updatedAt,
        url: comment.url,
      },
      state: save.state ?? null,
    };
    if (options.dryRun) {
      log(`(dry run) would append to ${auditEventsPath}:`);
      log(JSON.stringify(event, null, 2));
      return 0;
    }
    appendFileSync(auditEventsPath, `${JSON.stringify(event)}\n`);
    log(`recorded: ${caseId} review of ${short} (${save.state ?? "state not saved"}), ${comment.url}`);
    return 0;
  } catch (e) {
    error(`case:review: ${message(e)}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const caseId = args.find((a) => !a.startsWith("--"));
  if (!caseId || !/^FF-\d{4}$/.test(caseId)) {
    console.error("usage: npm run case:review -- <FF-NNNN> [--dry-run]");
    process.exit(2);
  }
  process.exit(run(caseId, { dryRun: args.includes("--dry-run") }));
}

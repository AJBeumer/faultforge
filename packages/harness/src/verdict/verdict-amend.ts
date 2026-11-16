/**
 * Adds an accurate reason to a verdict already recorded, without replacing it.
 *
 *   npm run verdict:amend -- FF-0012
 *   npm run verdict:amend -- FF-0012 --dry-run     # prints the line it would append, writes nothing
 *
 * The verdict itself stays as it was, so `case:build` keeps building the same record. The new reason goes
 * into one amendment line that changes no locked field, so `ledger:check` accepts it. The reason must differ
 * from the original and from every other case's reason, and the owner says whether they wrote it.
 *
 * Exit codes: 0 the amendment was appended (or, with `--dry-run`, printed); 1 nothing was written because it
 * was refused: stdin is not a terminal, who wrote the reason got no y or n, the verdict already has an amended reason (or gained one, or was
 * replaced, while the owner answered), or no acceptable reason was given after retrying; 2 nothing was written because it couldn't run: usage, the answer key or audit log has a
 * problem, the case has no verdict, its saved review can't be found, the owner's login can't be read, or the
 * line couldn't be appended.
 *
 * An unexpected error, even while loading, is 2 too: `npm run verdict:amend` runs `verdict-amend-cli.ts`.
 */
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { type LedgerEntry, readAuditLog, readLedger } from "../ledger/ledger.ts";
import { appendAmendment } from "../ledger/ledger-append.ts";
import { ledgerProblemsWithHistory } from "../ledger/ledger-check.ts";
import { casePr, findSavedReview, savedReviewsDir } from "../review/saved-review.ts";
import { errorText as message } from "../shared/error-text.ts";
import { gh } from "../shared/github.ts";
import { privateDir } from "../shared/templates.ts";
import { type AskFn, askDraftedBy, askOwnReason, defaultAsk } from "./verdict-ask.ts";
import { latestVerdict, normalReason, reasonsOfOtherCases } from "./verdict-event.ts";

export const AMENDMENT_REASON = "Adds an accurate reason, written after the verdict; the original reason is kept.";

export interface AmendOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  isTTY?: boolean;
  dryRun?: boolean;
  groundTruthPath?: string;
  auditEventsPath?: string;
  reviewsDir?: string;
  ask?: AskFn;
  ownerLogin?: () => string;
  now?: () => string;
  append?: (path: string, value: object) => void;
}

export async function run(caseId: string, options: AmendOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const root = privateDir(env);
  const groundTruthPath = options.groundTruthPath ?? join(root, "ground-truth.jsonl");
  const auditEventsPath = options.auditEventsPath ?? join(root, "audit-events.jsonl");
  const reviewsDir = options.reviewsDir ?? savedReviewsDir(env);

  const problems = ledgerProblemsWithHistory([groundTruthPath, auditEventsPath]);
  if (problems.length) {
    error(`verdict:amend: the answer key or audit log has problems:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    return 2;
  }
  let events: LedgerEntry[];
  let entry: LedgerEntry | undefined;
  try {
    events = readAuditLog(auditEventsPath);
    entry = readLedger(groundTruthPath).find((e) => e.caseId === caseId);
  } catch (e) {
    error(`verdict:amend: can't read ${groundTruthPath} or ${auditEventsPath}: ${message(e)}`);
    return 2;
  }
  const caseEvents = events.filter((e) => e.caseId === caseId);
  const verdict = latestVerdict(caseEvents);
  if (!verdict) {
    error(`verdict:amend: ${caseId} has no verdict to add a reason to`);
    return 2;
  }
  // An amendment names its target by id; a case id would name all the case's events at once.
  if (typeof verdict.eventId !== "string") {
    error(`verdict:amend: ${caseId}'s verdict has no event id, so no amendment can name it; ask the owner`);
    return 2;
  }
  // The evidence is what the verdict judged: the file it names, else its PR's save, else (an old case with
  // no save) its case record.
  const save = entry ? findSavedReview(reviewsDir, String(entry.injectionCommit), casePr(caseEvents)) : undefined;
  const record = join(root, "cases", `${caseId}.json`);
  const evidence =
    typeof verdict.reviewFile === "string"
      ? verdict.reviewFile
      : save
        ? relative(root, save.path).replace(/\\/g, "/")
        : existsSync(record)
          ? `cases/${caseId}.json`
          : undefined;
  if (!evidence) {
    error(`verdict:amend: neither the review ${caseId}'s verdict judged nor its case record can be found`);
    return 2;
  }

  log(`${caseId}: ${String(verdict.disposition)}, recorded ${String(verdict.at)} by ${String(verdict.by ?? "?")}`);
  log(`reason on record: ${String(verdict.reason ?? "(none)")}`);
  if (typeof verdict.amendedReason === "string") {
    log(`amended reason on record: ${verdict.amendedReason}`);
    error(`verdict:amend: ${caseId}'s verdict already has an amended reason; nothing written`);
    return 1;
  }
  if (!(options.isTTY ?? process.stdin.isTTY === true)) {
    log("(no terminal to ask on: nothing written)");
    return 1;
  }
  let by: string;
  try {
    by = (options.ownerLogin ?? (() => gh("api", "user", "--jq", ".login").trim()))();
  } catch (e) {
    error(`verdict:amend: can't determine the owner's login: ${message(e)}`);
    return 2;
  }

  // A new reason must say something new: neither the original nor any other case's reason.
  const taken = reasonsOfOtherCases(events, caseId);
  if (typeof verdict.reason === "string") taken.add(normalReason(verdict.reason));
  const ask = options.ask ?? defaultAsk;
  const reason = await askOwnReason(ask, "Accurate reason for this verdict: ", taken);
  if (typeof reason !== "string") {
    error(
      reason.taken
        ? "verdict:amend: that reason is the original one, or another case's; nothing written"
        : "verdict:amend: no reason given; nothing written",
    );
    return 1;
  }
  // Its own field: the verdict's `reasonDraftedBy` is about the original reason, which stays as it was.
  const draftedBy = await askDraftedBy(ask);
  if (!draftedBy) {
    error("verdict:amend: no answer (y or n) to who wrote the reason; nothing written");
    return 1;
  }

  const at = (options.now ?? (() => new Date().toISOString()))();
  const amendment = {
    kind: "amendment" as const,
    amends: verdict.eventId as string,
    at,
    change: {
      amendedReason: reason,
      amendedReasonAt: at,
      amendedReasonBy: by,
      amendedReasonWrittenLater: true,
      amendedReasonDraftedBy: draftedBy,
    },
    reason: AMENDMENT_REASON,
    evidence,
  };
  if (options.dryRun) {
    log(`(dry run) would append to ${auditEventsPath}:`);
    log(JSON.stringify(amendment, null, 2));
    return 0;
  }
  try {
    // Read again just before writing: another run may have amended or replaced the verdict meanwhile.
    const fresh = readAuditLog(auditEventsPath);
    const again = latestVerdict(fresh.filter((e) => e.caseId === caseId));
    const takenNow = reasonsOfOtherCases(fresh, caseId).has(normalReason(reason));
    if (again?.eventId !== verdict.eventId || again.amendedReason !== undefined || takenNow) {
      error(`verdict:amend: ${caseId}'s verdict changed while you answered; nothing written`);
      return 1;
    }
    const { kind: _kind, ...line } = amendment;
    if (options.append) options.append(auditEventsPath, amendment);
    else appendAmendment(auditEventsPath, line);
  } catch (e) {
    error(`verdict:amend: can't append to ${auditEventsPath}: ${message(e)}`);
    return 2;
  }
  log(`amended: ${caseId}'s verdict ${verdict.eventId} now also carries a reason written later`);
  return 0;
}

/** The command: `verdict-amend-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(argv: string[]): Promise<number> | number {
  let parsed: { values: { "dry-run"?: boolean }; positionals: string[] } | undefined;
  try {
    parsed = parseArgs({ args: argv, options: { "dry-run": { type: "boolean" } }, allowPositionals: true });
  } catch {
    parsed = undefined;
  }
  const caseId = parsed?.positionals[0];
  if (!parsed || !caseId || !/^FF-\d{4}$/.test(caseId)) {
    console.error("usage: npm run verdict:amend -- <FF-NNNN> [--dry-run]");
    return 2;
  }
  return run(caseId, { dryRun: parsed.values["dry-run"] ?? false });
}

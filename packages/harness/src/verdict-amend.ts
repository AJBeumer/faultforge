/**
 * Adds an accurate reason to a verdict already recorded, without replacing it (AUD-H4).
 *
 *   npm run verdict:amend -- FF-0012
 *   npm run verdict:amend -- FF-0012 --dry-run     # prints the line it would append, writes nothing
 *
 * It never re-runs or replaces a verdict: the disposition, the original reason, the judgements and the
 * time stay as they were, so `case:build` keeps building the same record. It appends one amendment line to
 * `private/audit-events.jsonl` naming the case's latest `case.adjudicated` event, whose `change` adds
 * `amendedReason` (the owner's new text), `amendedReasonAt` (now) and `amendedReasonBy` (the owner's
 * login), and marks it `amendedReasonWrittenLater: true`. The amendment's own `reason` says so, and its
 * `evidence` is the saved review the verdict judged. `ledger:check` accepts it: no locked field changes.
 *
 * Asked on a terminal, as `verdict` asks: it prints the verdict and its reason, then asks for the new reason,
 * which must be nonblank, differ from the original, and not be any other case's reason or amended reason.
 *
 * Exit codes: 0 the amendment was appended (or, with `--dry-run`, printed); 1 nothing was written because it
 * was refused: stdin is not a terminal, the verdict already has an amended reason, or no acceptable reason was
 * given after retrying; 2 nothing was written because it couldn't run: usage, the answer key or audit log has a
 * problem, the case has no verdict, its saved review can't be found, the owner's login can't be read, or the
 * line couldn't be appended.
 */
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { errorText as message } from "./error-text.ts";
import { gh } from "./github.ts";
import { type LedgerEntry, readAuditLog, readLedger } from "./ledger.ts";
import { appendAmendment } from "./ledger-append.ts";
import { ledgerProblemsWithHistory } from "./ledger-check.ts";
import { casePr, findSavedReview, savedReviewsDir } from "./saved-review.ts";
import { privateDir } from "./templates.ts";
import { type AskFn, askOwnReason, defaultAsk } from "./verdict-ask.ts";
import { normalReason, reasonsOfOtherCases } from "./verdict-event.ts";

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
  const verdict = caseEvents.filter((e) => e.type === "case.adjudicated").at(-1);
  if (!verdict || typeof verdict.eventId !== "string") {
    error(`verdict:amend: ${caseId} has no verdict to add a reason to`);
    return 2;
  }
  const save = entry ? findSavedReview(reviewsDir, String(entry.injectionCommit), casePr(caseEvents)) : undefined;
  if (!save) {
    error(`verdict:amend: the saved review ${caseId}'s verdict judged can't be found under ${reviewsDir}`);
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

  // Neither the reason it replaces in meaning nor any other case's reason (AUD-H4).
  const taken = reasonsOfOtherCases(events, caseId);
  if (typeof verdict.reason === "string") taken.add(normalReason(verdict.reason));
  const reason = await askOwnReason(options.ask ?? defaultAsk, "Accurate reason for this verdict: ", taken);
  if (typeof reason !== "string") {
    error(
      reason.taken
        ? "verdict:amend: that reason is the original one, or another case's; nothing written"
        : "verdict:amend: no reason given; nothing written",
    );
    return 1;
  }

  const at = (options.now ?? (() => new Date().toISOString()))();
  const amendment = {
    kind: "amendment" as const,
    amends: verdict.eventId as string,
    at,
    change: { amendedReason: reason, amendedReasonAt: at, amendedReasonBy: by, amendedReasonWrittenLater: true },
    reason: AMENDMENT_REASON,
    // The file the verdict hashed when it names one, else its case's PR's save.
    evidence:
      typeof verdict.reviewFile === "string" ? verdict.reviewFile : relative(root, save.path).replace(/\\/g, "/"),
  };
  if (options.dryRun) {
    log(`(dry run) would append to ${auditEventsPath}:`);
    log(JSON.stringify(amendment, null, 2));
    return 0;
  }
  try {
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let parsed: { values: { "dry-run"?: boolean }; positionals: string[] } | undefined;
  try {
    parsed = parseArgs({ options: { "dry-run": { type: "boolean" } }, allowPositionals: true });
  } catch {
    parsed = undefined;
  }
  const caseId = parsed?.positionals[0];
  if (!parsed || !caseId || !/^FF-\d{4}$/.test(caseId)) {
    console.error("usage: npm run verdict:amend -- <FF-NNNN> [--dry-run]");
    process.exit(2);
  }
  run(caseId, { dryRun: parsed.values["dry-run"] ?? false })
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      console.error(`verdict:amend: ${message(e)}`);
      process.exit(2);
    });
}

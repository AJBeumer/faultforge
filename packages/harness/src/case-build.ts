/**
 * Builds the public case record from saved evidence, instead of it being edited by hand. A generated
 * record can't drift from the events that back it, and anyone can regenerate it from the same inputs.
 *
 *   npm run case:build -- FF-0001              # prints the record
 *   npm run case:build -- FF-0001 --write      # writes examples/<caseId>.json
 *
 * Reads, for `<caseId>`:
 *  - the ground-truth entry (`readLedger`, amendments applied): `injection` and `target`.
 *  - the case's audit events (`readAuditLog`, amendments applied), filtered to this case. Three stages
 *    are required, and a case missing one is refused, naming it. When more than one event of a stage
 *    exists (a re-review, a corrected verdict), the most recent one (by `at`) is the one that counts:
 *    `sabotage.injected` or `control.injected` (the case was planted); `review.recorded` (`pr`, and all
 *    of `review` — `reviewer`, `path`, `configVersion`, `reviewedCommit`, `reviewedAt`, `url` — are
 *    required on the event itself, never defaulted); `case.adjudicated` (`human.disposition`,
 *    `.adjudicatedBy` from `by`, `.adjudicatedAt` from `at`). `reviewedCommit` must equal the ground
 *    truth's injected commit, and `case.adjudicated`'s `commit`, when the event carries one, must equal
 *    it too; a case whose events disagree on which commit was reviewed is refused.
 *  - `private/cases/<caseId>.overlay.json`, when there is any: prose no event or saved review holds —
 *    `detection.notes`, `collateral`, `otherReviewers`, `challenge`, `review.linkedRepositories`. The
 *    overlay itself opts a case into the legacy path by setting `legacyFindingsPath` (a raw findings
 *    file, read in Qodo's API shape and converted with `findingsFor` from `qodo-review.ts`) — a case
 *    without it must have a saved review file. This is a declaration, not a guess from what happens to
 *    exist on disk: a `review.json` backfilled for an unrelated ticket's testing doesn't make a legacy
 *    case look ordinary, or an ordinary case look legacy. Only a legacy case (so far, only FF-0001,
 *    whose review predates both `review:wait` and the current wording of `match-rule.ts`'s criteria)
 *    may also set two narrow extras: `detection.matchDetailOverrides` (replaces a criterion's free-text
 *    `detail`, never its `pass`) and `findings` (per-id `severity`/`commentLines`/`summary`, which a
 *    legacy raw findings file doesn't carry). The command refuses any other field, or shape, naming it,
 *    and prints which fields it took from the overlay. With no overlay file, the record says its
 *    challenge has not run (#162).
 *  - for an ordinary case, the saved review (`review:wait`'s `<evidence>/reviews/<key>-pr<N>/*.review.json`,
 *    matched by `reviewedCommit`, via `findSavedReview` from `saved-review.ts`) for `findings`, cross-checked
 *    against `review.recorded`'s `pr` so a saved file for the right commit but the wrong PR is refused,
 *    not silently used.
 *
 * `detection` comes from `applyMatchRule`: the matched finding's criteria when caught, the first
 * finding's otherwise, folded into the schema's single `match` object (one set of criteria, not one
 * per finding) and (for a legacy review only) re-worded by `matchDetailOverrides`.
 *
 * A control (#162) reads no match terms and has no `detection`. Its record has a `change` block from the
 * answer key (template, file, lines, commit) and the overlay's `notes`, which only version 2 holds, so a
 * control's record is always version 2. A bug case's record stays version 1 and keeps its bytes.
 *
 * `--write` also appends a `case.published` audit event (the written record's `sha256` and `path`).
 * Writing the same case twice with unchanged content is a no-op the second time (the file is
 * rewritten, but no duplicate event is appended) rather than a new event every run.
 *
 * Exit codes: 0 the record is valid and leak-free (`validateCaseRecord` + `findLeaks`), printed or
 * written; 1 the record fails those checks, or the overlay sets a field it isn't allowed to (problems
 * listed); 2 nothing was built, because an input is missing or unreadable (the answer key, the events, a
 * bug case's template, the saved review, or an overlay file that exists), the answer key or audit log has an
 * amendment or history problem, or the inputs disagree (a missing stage, disagreeing commits, or a saved review for the
 * wrong PR). The message names which.
 */

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildCaseRecord, latestEvent, type Overlay, requireField } from "./case-builder.ts";
import { overlayFieldsTaken, overlayProblems } from "./case-overlay.ts";
import { findLeaks, validateCaseRecord } from "./case-record.ts";
import { type LedgerEntry, readAuditLog, readLedger } from "./ledger.ts";
import { ledgerProblemsWithHistory } from "./ledger-check.ts";
import { ROOT } from "./paths.ts";
import { type Finding, findingsFor, type QodoReview } from "./qodo-review.ts";
import { printRecord } from "./record-print.ts";
import { findSavedReview } from "./saved-review.ts";
import { isPublishedTemplate, kindTermsOf, privateDir, templateDir } from "./templates.ts";

/** This repo, where adjudicated templates are published, for `injection.template`. */
const TEMPLATE_REPO = "AJBeumer/faultforge";

interface CliArgs {
  caseId: string;
  write: boolean;
}

/** The command line, or null when it's wrong. */
export function parseCliArgs(argv: string[]): CliArgs | null {
  let values: { write?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { write: { type: "boolean" } },
      allowPositionals: true,
    }));
  } catch {
    return null;
  }
  const [caseId] = positionals;
  if (!caseId) return null;
  return { caseId, write: values.write ?? false };
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  groundTruthPath?: string;
  auditEventsPath?: string;
  reviewsDir?: string;
  overlayPath?: string;
  examplesDir?: string;
  write?: boolean;
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * True for a file `review:wait` wrote. Every save it writes carries the `reviewSeenCompleteAt` field: a
 * time when it saw the review finish, or `null` when it never did (timed out, or the head moved). A file
 * backfilled by hand, as FF-0001's was, has no such field. The value can't be the test: a save of a review
 * that never finished is a real save too, and the one an inconclusive record is built from (#192).
 */
function isReviewWaitSave(review: Record<string, unknown>): boolean {
  return Object.hasOwn(review, "reviewSeenCompleteAt");
}

export async function run(caseId: string, options: RunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const root = privateDir(env);
  const groundTruthPath = options.groundTruthPath ?? join(root, "ground-truth.jsonl");
  const auditEventsPath = options.auditEventsPath ?? join(root, "audit-events.jsonl");
  const reviewsDir = options.reviewsDir ?? join(root, "raw-artifacts", "reviews");
  const overlayPath = options.overlayPath ?? join(root, "cases", `${caseId}.overlay.json`);
  const examplesDir = options.examplesDir ?? join(ROOT, "examples");

  let entry: LedgerEntry | undefined;
  let events: LedgerEntry[];
  try {
    // A record is built only from an answer key and audit log whose amendments check out (#192), checked
    // before anything is read from them: an amendment that changes a case id would hide the case itself.
    const ledgerIssues = ledgerProblemsWithHistory([groundTruthPath, auditEventsPath]);
    if (ledgerIssues.length) {
      error(`case:build: the answer key or audit log has problems:\n${ledgerIssues.map((p) => `- ${p}`).join("\n")}`);
      return 2;
    }
    entry = readLedger(groundTruthPath).find((e) => e.caseId === caseId);
    events = readAuditLog(auditEventsPath).filter((e) => e.caseId === caseId);
  } catch (e) {
    error(`case:build: can't read ${groundTruthPath} or ${auditEventsPath}: ${message(e)}`);
    return 2;
  }
  if (!entry) {
    error(`case:build: no ground-truth entry for ${caseId} in ${groundTruthPath}`);
    return 2;
  }

  // The overlay holds prose no event or saved review has; a case with none to add needs no file (#162).
  let overlay: Overlay = {};
  try {
    if (existsSync(overlayPath)) overlay = JSON.parse(readFileSync(overlayPath, "utf8"));
  } catch (e) {
    error(`case:build: can't read ${overlayPath}: ${message(e)}`);
    return 2;
  }

  const injectionCommit = entry.injectionCommit as string;
  // A saved review counts only if it carries the timing fields only review:wait's wait loop writes
  // (pushSeenAt, reviewStartedAt, reviewSeenCompleteAt): a review.json backfilled by hand (as FF-0001's
  // was, for an unrelated ticket's testing) can't masquerade as one, and the saved review always wins
  // over the overlay's legacy path when it genuinely exists.
  const foundReview = findSavedReview(reviewsDir, injectionCommit);
  const saved =
    foundReview && isReviewWaitSave(foundReview.review as unknown as Record<string, unknown>) ? foundReview : undefined;
  const isLegacy = !saved;

  const overlayIssues = overlayProblems(overlay as Record<string, unknown>, isLegacy);
  if (overlayIssues.length) {
    log(`[case:build] overlay problems:\n${overlayIssues.map((p) => `- ${p}`).join("\n")}`);
    return 1;
  }
  for (const field of overlayFieldsTaken(overlay as Record<string, unknown>))
    log(`[case:build] from overlay: ${field}`);

  let findings: Finding[];
  if (!saved) {
    if (!overlay.legacyFindingsPath) {
      error(
        `case:build: no saved review for commit ${injectionCommit} under ${reviewsDir}, and no legacyFindingsPath in the overlay`,
      );
      return 2;
    }
    let raw: QodoReview;
    try {
      raw = JSON.parse(readFileSync(resolve(ROOT, overlay.legacyFindingsPath), "utf8"));
    } catch (e) {
      error(`case:build: can't read ${overlay.legacyFindingsPath}: ${message(e)}`);
      return 2;
    }
    findings = findingsFor(raw, injectionCommit);
  } else {
    let reviewPr: number | undefined;
    try {
      const reviewEvent = latestEvent(events, ["review.recorded"], "the review stage") as unknown as Record<
        string,
        unknown
      >;
      reviewPr = requireField<{ number: number }>(reviewEvent, "pr", "the review stage").number;
    } catch (e) {
      error(`case:build: ${message(e)}`);
      return 2;
    }
    if (saved.review.pr !== undefined && saved.review.pr !== reviewPr) {
      error(
        `case:build: the saved review at ${saved.path} is for PR ${saved.review.pr}, but this case's review.recorded event is for PR ${reviewPr}`,
      );
      return 2;
    }
    // verdict.ts's SavedFinding doesn't declare severity, but the file review:wait writes has it
    // (review-wait.ts's Finding); dropping it here would silently publish an empty severity.
    const savedFindings = (saved.review.findings ?? []) as unknown as Finding[];
    findings = savedFindings.map((f) => ({
      id: f.id,
      file: f.file,
      lines: f.lines,
      severity: f.severity ?? null,
      category: f.category ?? null,
      title: f.title ?? null,
      description: f.description ?? null,
    }));
  }

  const templateId = entry.templateId as string | undefined;
  let kindTerms: string[] = [];
  let templateUrl: string | undefined;
  // A control's template declares no match terms (the schema forbids them): it is looked up only for the
  // published template's URL (#162).
  if (templateId && entry.kind === "control") {
    const dir = templateDir(templateId, env);
    if (dir && isPublishedTemplate(dir)) {
      templateUrl = `https://github.com/${TEMPLATE_REPO}/tree/main/templates/seed/${templateId}`;
    }
  } else if (templateId) {
    const dir = templateDir(templateId, env);
    if (!dir) {
      error(`case:build: template ${templateId} not found in private/templates or templates/seed`);
      return 2;
    }
    try {
      kindTerms = kindTermsOf(JSON.parse(readFileSync(join(dir, "template.json"), "utf8")), `${dir}/template.json`);
    } catch (e) {
      error(`case:build: can't use ${dir}/template.json: ${message(e)}`);
      return 2;
    }
    if (isPublishedTemplate(dir)) {
      templateUrl = `https://github.com/${TEMPLATE_REPO}/tree/main/templates/seed/${templateId}`;
    }
  }

  let record: Record<string, unknown>;
  try {
    record = buildCaseRecord({ entry, events, findings, overlay, kindTerms, templateUrl });
  } catch (e) {
    error(`case:build: ${message(e)}`);
    return 2;
  }

  const problems = [...validateCaseRecord(record), ...findLeaks(JSON.stringify(record))];
  if (problems.length) {
    log(`[case:build] problems found:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    return 1;
  }

  const text = `${printRecord(record)}\n`;
  if (!options.write) {
    log(text.trimEnd());
    return 0;
  }
  const outPath = join(examplesDir, `${caseId}.json`);
  writeFileSync(outPath, text);
  const hash = sha256(text);
  const alreadyPublished = events.some((e) => e.type === "case.published" && e.sha256 === hash);
  if (alreadyPublished) {
    log(`[case:build] wrote ${outPath} (already recorded as published with this content)`);
    return 0;
  }
  appendFileSync(
    auditEventsPath,
    `${JSON.stringify({
      eventId: randomUUID(),
      type: "case.published",
      at: new Date().toISOString(),
      caseId,
      sha256: hash,
      path: `examples/${caseId}.json`,
    })}\n`,
  );
  log(`[case:build] wrote ${outPath}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed) {
    console.error("usage: npm run case:build -- <caseId> [--write]");
    process.exit(2);
  }
  run(parsed.caseId, { write: parsed.write }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`case:build: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}

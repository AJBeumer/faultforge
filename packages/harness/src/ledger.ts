/**
 * Reads the answer key (`private/ground-truth.jsonl`) and the audit log (`private/audit-events.jsonl`).
 * Both are append-only: a correction is a new line, never an edit to an old one.
 *
 * An amendment line looks like:
 *
 *   { "kind": "amendment", "amends": <caseId or eventId>, "at": <UTC time>,
 *     "change": { <field>: <new value> }, "reason": <one sentence>,
 *     "evidence": <a path in the evidence store or a public record> }
 *
 * `readLedger` and `readAuditLog` return every other line (an entry keyed by `eventId`, or by `caseId`
 * when it has no `eventId`: an audit event carries both, and only `eventId` picks out one event among
 * several that share a case), each merged with the `change` of every amendment that names it, applied
 * in file order, plus the list of those amendments on an `amendments` field, attached last so a
 * `change` can never overwrite it. An amendment whose target is missing, or whose target id is held by
 * more than one entry, is left unapplied; `ledgerProblems` is what reports that as a problem.
 *
 * `ledgerProblems` refuses an amendment that: names an entry the file doesn't hold or that more than
 * one entry holds, has no `reason` or `evidence` (blank or whitespace-only counts as none), amends
 * another amendment, has a `change` that isn't an object of fields, or changes a locked field
 * (`LOCKED_FIELDS`: the ones that identify a line and place it in history, and the ones a result
 * stands on). It also flags any id held by more than one entry, whether or not an amendment names it.
 * `SET_ONCE_FIELDS` (which review, configuration and PR a case stands on, and who judged it) may be added
 * by an amendment to an entry that lacks them, as FF-0001's events, written before those fields existed,
 * were; never changed once there, by the entry itself or an earlier amendment (AUD-M10).
 *
 * The audit log's events, one per stage, read by `case-build.ts` (#11):
 *  - `sabotage.injected` / `control.injected`: the case was planted. Carries only `branch`, the name
 *    actually used in the target (the template's base name, or that with a numeric suffix when a case
 *    already used the base name); otherwise its presence just confirms the stage happened.
 *  - `review.recorded`: `pr` (`repo`, `number`, `url`) and the parts of the public record's `review`
 *    a saved `review:wait` file doesn't carry — `reviewer`, `path`, `configVersion`, `reviewedCommit`,
 *    `reviewedAt`, `url`.
 *  - `case.adjudicated`: the owner's verdict (`#19`'s `verdict.ts`). `disposition` becomes
 *    `human.disposition`; `by` becomes `human.adjudicatedBy`; `at` becomes `human.adjudicatedAt`.
 *  - `case.evidence-added`: extra evidence was saved after adjudication (a free-text `note`). Not
 *    required to build a record.
 *  - `case.published`: `case-build.ts --write` appended one, carrying the written record's `sha256`
 *    and `path`.
 *
 * `case-build.ts` requires `sabotage.injected`/`control.injected`, `review.recorded` and
 * `case.adjudicated` for the case it's building; a case missing one is refused, naming the stage.
 */
import { existsSync } from "node:fs";
import { readJsonLines } from "./jsonl.ts";

export interface Amendment {
  kind: "amendment";
  amends?: string;
  at?: string;
  change?: Record<string, unknown>;
  reason?: string;
  evidence?: string;
}

export type LedgerLine = Record<string, unknown>;
export type LedgerEntry = LedgerLine & { amendments: Amendment[] };

// eventId first: an audit event carries both fields, and only eventId is unique among its siblings
// that share a caseId. A ground-truth entry has no eventId, so it falls back to caseId.
const ID_FIELDS = ["eventId", "caseId"] as const;
/**
 * Fields no amendment may change. The first four identify a line and place it in history. The rest are
 * what a result stands on (AUD-M10): what was planted and where (`templateId`, `injectedFile`,
 * `injectedLines`, the commits), what was reviewed and hashed, and the owner's verdict and its original
 * reason. A wrong verdict is replaced by a new `verdict --supersede`, a wrong location by a new case.
 */
export const LOCKED_FIELDS = [
  "caseId",
  "eventId",
  "kind",
  "at",
  "type",
  "templateId",
  "invariantId",
  "defectClass",
  "targetRepo",
  "branch",
  "validation",
  "injectedFile",
  "injectedLines",
  "injectionCommit",
  "targetCommit",
  "commit",
  "inputHash",
  "reviewFile",
  "disposition",
  "reason",
  "judgements",
  "ruleVersion",
] as const;

/**
 * Fields an amendment may add to an entry that doesn't hold them, but never change: a review event's `pr`
 * and `review` (the reviewed commit, configuration version and PR), and a verdict's `by` (AUD-M10).
 */
export const SET_ONCE_FIELDS = ["review", "pr", "by"] as const;

function idOf(line: LedgerLine): string | undefined {
  for (const field of ID_FIELDS) {
    const value = line[field];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function isAmendment(line: LedgerLine): line is Amendment & LedgerLine {
  return line.kind === "amendment";
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function readLines(path: string): LedgerLine[] {
  return readJsonLines<LedgerLine>(path);
}

/** Ids held by more than one non-amendment entry: an amendment naming one can't pick a single target. */
function duplicateIds(lines: LedgerLine[]): Set<string> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (isAmendment(line)) continue;
    const id = idOf(line);
    if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

/** Every non-amendment line, in file order, with the amendments that name it applied. */
function applyAmendments(path: string, keep?: (amendment: Amendment, nth: number) => boolean): LedgerEntry[] {
  const lines = readLines(path);
  const ambiguous = duplicateIds(lines);
  const baseEntries: LedgerLine[] = [];
  const byId = new Map<string, LedgerLine>();
  for (const line of lines) {
    if (isAmendment(line)) continue;
    const entry: LedgerLine = { ...line };
    baseEntries.push(entry);
    const id = idOf(line);
    if (id !== undefined && !ambiguous.has(id)) byId.set(id, entry);
  }
  const amendmentsFor = new Map<LedgerLine, Amendment[]>();
  for (const line of lines) {
    if (!isAmendment(line)) continue;
    const target = line.amends !== undefined ? byId.get(line.amends) : undefined;
    if (!target) continue;
    const applied = amendmentsFor.get(target) ?? [];
    if (keep && !keep(line, applied.length)) continue;
    Object.assign(target, line.change ?? {});
    applied.push(line);
    amendmentsFor.set(target, applied);
  }
  // Attached last, so a change that names its own field "amendments" can never overwrite this list.
  return baseEntries.map((entry) => ({ ...entry, amendments: amendmentsFor.get(entry) ?? [] }));
}

/** The answer key's cases, amendments applied. */
export function readLedger(path: string): LedgerEntry[] {
  return applyAmendments(path);
}

/**
 * Every version an entry has had, oldest first: with none of its amendments applied, then the first, the
 * first two, and so on. The file is append-only, so whatever a tool read at some moment was one of these;
 * a verdict's `inputHash` covers whichever it was, whatever times the amendments claim.
 */
export function entryVersions(path: string, id: string): LedgerEntry[] {
  const all = applyAmendments(path).find((e) => idOf(e) === id);
  if (!all) return [];
  return Array.from({ length: all.amendments.length + 1 }, (_, count) =>
    applyAmendments(path, (amendment, nth) => amendment.amends !== id || nth < count).find((e) => idOf(e) === id),
  ).filter((e): e is LedgerEntry => e !== undefined);
}

/** The audit log's events, amendments applied. */
export function readAuditLog(path: string): LedgerEntry[] {
  return applyAmendments(path);
}

/**
 * `ledgerProblems` for each file that exists, each problem prefixed with its file. `verdict` and
 * `case:build` refuse to run while this is not empty (#192); a missing file is not a problem here.
 */
export function ledgerProblemsIn(paths: string[]): string[] {
  return paths.filter((path) => existsSync(path)).flatMap((path) => ledgerProblems(path).map((p) => `${path}: ${p}`));
}

/** Problems with the amendments in a ledger or audit log file, or an empty list if there are none. */
export function ledgerProblems(path: string): string[] {
  const lines = readLines(path);
  const ambiguous = duplicateIds(lines);
  // Keyed by whichever id field is present, on every line: a malformed amendment can carry one too,
  // which is how an amendment can itself be named as another amendment's target.
  const byId = new Map<string, LedgerLine>();
  for (const line of lines) {
    const id = idOf(line);
    if (id !== undefined) byId.set(id, line);
  }

  const problems: string[] = [];
  for (const id of ambiguous) problems.push(`${id} is held by more than one entry`);
  // The set-once fields each entry holds so far: its own, then those each earlier amendment added, in file order.
  const held = new Map<LedgerLine, Set<string>>();

  for (const line of lines) {
    if (!isAmendment(line)) continue;
    const label = `amendment amending ${line.amends ?? "(no target named)"}`;
    if (line.amends !== undefined && ambiguous.has(line.amends)) {
      problems.push(`${label}: that id is held by more than one entry, so the target is ambiguous`);
      continue;
    }
    const target = line.amends !== undefined ? byId.get(line.amends) : undefined;
    if (!target) {
      problems.push(`${label}: the file doesn't hold that entry`);
      continue;
    }
    if (isAmendment(target)) {
      problems.push(`${label}: that is itself an amendment`);
      continue;
    }
    if (isBlank(line.reason)) problems.push(`${label}: has no reason`);
    if (isBlank(line.evidence)) problems.push(`${label}: has no evidence`);
    // A string or a list would be spread into numbered fields when applied: only an object of fields is a change.
    if (typeof line.change !== "object" || line.change === null || Array.isArray(line.change)) {
      problems.push(`${label}: its change isn't an object of fields`);
      continue;
    }
    const touched = LOCKED_FIELDS.filter((field) => line.change && Object.hasOwn(line.change, field));
    if (touched.length) problems.push(`${label}: changes ${touched.join(", ")}, which an amendment may not touch`);
    const change = line.change;
    const already = held.get(target) ?? new Set(SET_ONCE_FIELDS.filter((field) => Object.hasOwn(target, field)));
    held.set(target, already);
    const rewritten = SET_ONCE_FIELDS.filter((field) => Object.hasOwn(change, field) && already.has(field));
    if (rewritten.length)
      problems.push(`${label}: changes ${rewritten.join(", ")}, which the entry already holds and may only be added`);
    for (const field of SET_ONCE_FIELDS) if (Object.hasOwn(change, field)) already.add(field);
  }
  return problems;
}

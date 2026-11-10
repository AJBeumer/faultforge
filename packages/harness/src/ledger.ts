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
 * another amendment, or changes `caseId`, `eventId`, `kind` or `at` — the fields that identify a line
 * and place it in history. It also flags any id held by more than one entry, whether or not an
 * amendment names it.
 */
import { readFileSync } from "node:fs";

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
const LOCKED_FIELDS = ["caseId", "eventId", "kind", "at"] as const;

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
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
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
function applyAmendments(path: string): LedgerEntry[] {
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
    Object.assign(target, line.change ?? {});
    const applied = amendmentsFor.get(target) ?? [];
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

/** The audit log's events, amendments applied. */
export function readAuditLog(path: string): LedgerEntry[] {
  return applyAmendments(path);
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
    const touched = LOCKED_FIELDS.filter((field) => line.change && Object.hasOwn(line.change, field));
    if (touched.length) problems.push(`${label}: changes ${touched.join(", ")}, which an amendment may not touch`);
  }
  return problems;
}

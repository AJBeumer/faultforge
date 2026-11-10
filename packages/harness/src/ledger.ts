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
 * `readLedger` and `readAuditLog` return every other line (an entry keyed by `caseId` or `eventId`),
 * each merged with the `change` of every amendment that names it, applied in file order, plus the list
 * of those amendments on an `amendments` field. An amendment whose target is missing is left unapplied;
 * `ledgerProblems` is what reports that as a problem.
 *
 * `ledgerProblems` refuses an amendment that: names an entry the file doesn't hold, has no `reason` or
 * `evidence`, amends another amendment, or changes `caseId`, `eventId`, `kind` or `at` — the fields that
 * identify a line and place it in history.
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

const ID_FIELDS = ["caseId", "eventId"] as const;
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

function readLines(path: string): LedgerLine[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** Every non-amendment line, in file order, with the amendments that name it applied. */
function applyAmendments(path: string): LedgerEntry[] {
  const lines = readLines(path);
  const entries: LedgerEntry[] = [];
  const byId = new Map<string, LedgerEntry>();
  for (const line of lines) {
    if (isAmendment(line)) continue;
    const entry: LedgerEntry = { ...line, amendments: [] };
    entries.push(entry);
    const id = idOf(line);
    if (id !== undefined) byId.set(id, entry);
  }
  for (const line of lines) {
    if (!isAmendment(line)) continue;
    const target = line.amends !== undefined ? byId.get(line.amends) : undefined;
    if (!target) continue;
    Object.assign(target, line.change ?? {});
    target.amendments.push(line);
  }
  return entries;
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
  // Keyed by whichever id field is present, on every line: a malformed amendment can carry one too,
  // which is how an amendment can itself be named as another amendment's target.
  const byId = new Map<string, LedgerLine>();
  for (const line of lines) {
    const id = idOf(line);
    if (id !== undefined) byId.set(id, line);
  }

  const problems: string[] = [];
  for (const line of lines) {
    if (!isAmendment(line)) continue;
    const target = line.amends !== undefined ? byId.get(line.amends) : undefined;
    const label = `amendment amending ${line.amends ?? "(no target named)"}`;
    if (!target) {
      problems.push(`${label}: the file doesn't hold that entry`);
      continue;
    }
    if (isAmendment(target)) {
      problems.push(`${label}: that is itself an amendment`);
      continue;
    }
    if (!line.reason) problems.push(`${label}: has no reason`);
    if (!line.evidence) problems.push(`${label}: has no evidence`);
    const touched = LOCKED_FIELDS.filter((field) => line.change && Object.hasOwn(line.change, field));
    if (touched.length) problems.push(`${label}: changes ${touched.join(", ")}, which an amendment may not touch`);
  }
  return problems;
}

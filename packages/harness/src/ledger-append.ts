/**
 * The one writer of the answer key and the audit log (AUD-M5). Every tool appends through here: an audit
 * event is checked against its type's schema (`schemas/audit-event.v1.json`) before it is written, an
 * amendment against the rules `ledgerProblems` reads it by, and an answer-key entry for a case the key
 * already holds is refused. Each append takes a lock file beside the ledger, refuses a file whose last line
 * isn't complete, and writes one line (AUD-N8).
 *
 * Reading stays lenient: `readEventProblems` accepts every shape written by hand before this module existed
 * (`pr.opened` in four key sets, events with no `tool`, reviews with no `state`), checking only what every
 * event on disk has always carried. Those lines may not be edited, so a stricter read would stop every tool.
 */
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ROOT } from "./paths.ts";

const eventSchema = new Ajv2020({ allErrors: true }).compile(
  JSON.parse(readFileSync(join(ROOT, "schemas/audit-event.v1.json"), "utf8")),
);

/** Every event type that has ever been written, by a tool or by hand. */
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "sabotage.injected",
  "control.injected",
  "case.ticket-created",
  "pr.opened",
  "review.recorded",
  "case.adjudicated",
  "case.evidence-added",
  "case.published",
  "ledger.amended",
]);

/** Why `event` may not be written, in plain words, or an empty list. */
export function eventProblems(event: unknown): string[] {
  if (eventSchema(event)) return [];
  return (eventSchema.errors ?? [])
    .filter((e) => e.keyword !== "if")
    .map((e) => {
      if (e.keyword === "additionalProperties") {
        return `${e.instancePath || "/"}: unknown property "${(e.params as { additionalProperty: string }).additionalProperty}"`;
      }
      return `${e.instancePath || "/"} ${e.message}`;
    });
}

/**
 * Why an event already on disk can't be read, or undefined. Only what every event has carried from the
 * start: an id, a known type, a readable time and a case id. Nothing a hand-written line may lack.
 */
export function readEventProblems(event: Record<string, unknown>): string | undefined {
  const id = typeof event.eventId === "string" && event.eventId ? event.eventId : undefined;
  const label = `event ${id ?? "(no eventId)"}`;
  if (!id) return `${label} has no eventId`;
  if (typeof event.type !== "string" || !KNOWN_EVENT_TYPES.has(event.type)) {
    return `${label} has an unknown type ${JSON.stringify(event.type)}`;
  }
  if (typeof event.at !== "string" || Number.isNaN(Date.parse(event.at))) return `${label} has no readable time`;
  if (typeof event.caseId !== "string" || !event.caseId) return `${label} names no case`;
  return undefined;
}

const LOCK_WAIT_MS = 5_000;

/** Runs `write` holding `<path>.lock`, created exclusively; a lock held too long is reported, never broken. */
function withLock(path: string, write: () => void): void {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lock, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() > deadline) {
        throw new Error(`${lock} has been held for over ${LOCK_WAIT_MS / 1000} s; if no tool is writing, remove it`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    write();
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

/** Throws unless the file is missing, empty, or ends with a complete line: a torn line must not be extended. */
function requireCompleteLastLine(path: string): void {
  if (!existsSync(path) || statSync(path).size === 0) return;
  if (!readFileSync(path, "utf8").endsWith("\n")) {
    throw new Error(`${path} doesn't end with a complete line; nothing appended`);
  }
}

function appendLine(path: string, value: object, check?: () => void): void {
  withLock(path, () => {
    requireCompleteLastLine(path);
    check?.();
    appendFileSync(path, `${JSON.stringify(value)}\n`);
  });
}

/** Appends one audit event, after checking it against its type's schema. Throws, writing nothing, if it fails. */
export function appendEvent(path: string, event: Record<string, unknown>): void {
  const problems = eventProblems(event);
  if (problems.length) {
    throw new Error(`refusing to write a ${String(event.type)} event: ${problems.join("; ")}`);
  }
  appendLine(path, event);
}

/**
 * Appends one amendment line. It must name its target, give a reason and evidence, and change a plain object
 * of fields; whether those fields may change is `ledgerProblems`'s rule, checked again by every reader.
 */
export function appendAmendment(
  path: string,
  amendment: { amends: string; at: string; change: Record<string, unknown>; reason: string; evidence: string },
): void {
  const { change } = amendment;
  if (typeof change !== "object" || change === null || Array.isArray(change) || !Object.keys(change).length) {
    throw new Error("refusing an amendment whose change isn't an object of fields");
  }
  if (!amendment.amends || !amendment.reason.trim() || !amendment.evidence.trim()) {
    throw new Error("refusing an amendment with no target, reason or evidence");
  }
  appendLine(path, { kind: "amendment", ...amendment });
}

/** Appends one answer-key entry, re-checking under the lock that no entry holds its case id yet (C-14). */
export function appendAnswerKeyEntry(path: string, entry: Record<string, unknown>): void {
  const caseId = entry.caseId;
  if (typeof caseId !== "string" || !/^FF-\d{4}$/.test(caseId)) {
    throw new Error(`refusing an answer-key entry with case id ${JSON.stringify(caseId)}`);
  }
  appendLine(path, entry, () => {
    const held = existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter((l) => l.trim())
          .some((l) => (JSON.parse(l) as { caseId?: unknown; kind?: unknown }).caseId === caseId)
      : false;
    if (held) throw new Error(`${caseId} is already in the answer key; nothing appended`);
  });
}

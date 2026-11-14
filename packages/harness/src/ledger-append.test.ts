import { appendFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ledgerProblems, readAuditLog } from "./ledger.ts";
import {
  appendAmendment,
  appendAnswerKeyEntry,
  appendEvent,
  eventProblems,
  readEventProblems,
} from "./ledger-append.ts";

const SHAPES = join(import.meta.dirname, "../fixtures/audit-event-shapes.jsonl");
const temp = (name: string) => join(mkdtempSync(join(tmpdir(), "ledger-append-")), name);

const PUBLISHED = {
  eventId: "e1",
  type: "case.published",
  at: "2026-11-14T00:00:00.000Z",
  caseId: "FF-9001",
  sha256: "a".repeat(64),
  path: "examples/FF-9001.json",
};

describe("every event shape on disk today still reads (AUD-M5, #251)", () => {
  it("passes the read check and the amendment check, one synthetic line per shape", () => {
    const events = readAuditLog(SHAPES);
    expect(events).toHaveLength(17);
    expect(events.map((e) => readEventProblems(e)).filter(Boolean)).toEqual([]);
    expect(ledgerProblems(SHAPES)).toEqual([]);
  });

  it("refuses on read only what no event ever lacked", () => {
    expect(readEventProblems({ type: "pr.opened", at: "2026-11-01T00:00:00Z", caseId: "FF-9001" })).toContain(
      "no eventId",
    );
    expect(
      readEventProblems({ eventId: "x", type: "pr.made", at: "2026-11-01T00:00:00Z", caseId: "FF-9001" }),
    ).toContain("unknown type");
    expect(readEventProblems({ eventId: "x", type: "pr.opened", at: "soon", caseId: "FF-9001" })).toContain(
      "no readable time",
    );
  });
});

describe("appendEvent", () => {
  it("writes an event that fits its type's schema, one line, after what was there", () => {
    const path = temp("audit-events.jsonl");
    writeFileSync(path, '{"eventId":"old"}\n');
    appendEvent(path, PUBLISHED);
    expect(readFileSync(path, "utf8")).toBe(`{"eventId":"old"}\n${JSON.stringify(PUBLISHED)}\n`);
  });

  it("refuses, writing nothing, an event that doesn't fit its schema", () => {
    const path = temp("audit-events.jsonl");
    expect(() => appendEvent(path, { ...PUBLISHED, sha256: "short" })).toThrow(/refusing to write/);
    expect(() => appendEvent(path, { ...PUBLISHED, extra: 1 })).toThrow(/unknown property "extra"/);
    expect(() => appendEvent(path, { ...PUBLISHED, type: "pr.opened" })).toThrow(/headCommit/);
    expect(() => appendEvent(path, { ...PUBLISHED, type: "case.evidence-added" })).toThrow();
    expect(readdirSync(join(path, "..")).filter((f) => f.startsWith("audit"))).toEqual([]);
  });

  it("refuses a file whose last line is torn, and a lock another writer holds", () => {
    const torn = temp("audit-events.jsonl");
    writeFileSync(torn, '{"eventId":"half');
    expect(() => appendEvent(torn, PUBLISHED)).toThrow(/complete line/);
    const locked = temp("audit-events.jsonl");
    writeFileSync(`${locked}.lock`, "");
    expect(() => appendEvent(locked, PUBLISHED, { lockWaitMs: 100 })).toThrow(/held for over/);
  });

  it("checks pr.opened and case.adjudicated as the tools write them", () => {
    const opened = {
      eventId: "o",
      type: "pr.opened",
      at: "2026-11-14T00:00:00Z",
      caseId: "FF-9001",
      tool: "faultforge-harness@1.0.0",
      environment: "x",
      repo: "Owner/target",
      pr: 5,
      url: "u",
      headCommit: "c".repeat(40),
      injectionCommit: "c".repeat(40),
      headMatchesInjection: true,
      openedAt: "2026-11-14T00:00:00Z",
      qodoConfiguration: "qodo-v9",
      qodoState: "raw-artifacts/qodo-state/x",
      relationships: "none active",
      ticket: 4,
    };
    expect(eventProblems(opened)).toEqual([]);
    expect(eventProblems({ ...opened, headMatchesInjection: false })).not.toEqual([]);
  });
});

describe("appendAmendment and appendAnswerKeyEntry", () => {
  it("refuses an amendment whose change isn't an object of fields", () => {
    const path = temp("audit-events.jsonl");
    const base = { amends: "e1", at: "2026-11-14T00:00:00Z", reason: "r", evidence: "e" };
    expect(() => appendAmendment(path, { ...base, change: "text" as never })).toThrow(/object of fields/);
    appendAmendment(path, { ...base, change: { note: "n" } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ kind: "amendment", amends: "e1" });
  });

  it("keeps every earlier answer-key line and refuses a case id it already holds (I01, I06)", () => {
    const path = temp("ground-truth.jsonl");
    appendAnswerKeyEntry(path, { caseId: "FF-9001", kind: "sabotage" });
    appendAnswerKeyEntry(path, { caseId: "FF-9002", kind: "control" });
    expect(() => appendAnswerKeyEntry(path, { caseId: "FF-9001", kind: "sabotage" })).toThrow(/already in/);
    appendFileSync(path, "");
    expect(
      readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).caseId),
    ).toEqual(["FF-9001", "FF-9002"]);
  });
});

describe("one writer (AUD-M5, #251)", () => {
  // These append to their own run logs, never to the answer key or the audit log.
  const RUN_LOG_WRITERS = ["factory-agent.ts", "factory-deps.ts"];

  it("no script appends to a file except through ledger-append.ts, so no event is written as a bare literal", () => {
    const sources = readdirSync(import.meta.dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const appending = sources.filter((f) =>
      /\bappendFileSync\b/.test(readFileSync(join(import.meta.dirname, f), "utf8")),
    );
    expect(appending.sort()).toEqual(["ledger-append.ts", ...RUN_LOG_WRITERS].sort());
  });

  it("no script opens either ledger for writing by name", () => {
    const sources = readdirSync(import.meta.dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const writes = sources.filter((f) =>
      /writeFileSync\([^)]*(ledgerPath|auditEventsPath|ground-truth|audit-events)/.test(
        readFileSync(join(import.meta.dirname, f), "utf8"),
      ),
    );
    expect(writes).toEqual([]);
  });
});

describe("appendAmendment: locked fields (Qodo on PR 269)", () => {
  it("refuses an amendment that changes a locked field, writing nothing", () => {
    const path = temp("audit-events.jsonl");
    const base = { amends: "e1", at: "2026-11-14T00:00:00Z", reason: "r", evidence: "e" };
    expect(() => appendAmendment(path, { ...base, change: { disposition: "confirmed_missed" } })).toThrow(/locked/);
    expect(readdirSync(join(path, "..")).filter((f) => f.startsWith("audit"))).toEqual([]);
  });
});

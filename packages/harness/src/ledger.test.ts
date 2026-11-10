import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ledgerProblems, readAuditLog, readLedger } from "./ledger.ts";

function fileOf(...lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const path = join(dir, "file.jsonl");
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

const CASE_A = { caseId: "FF-0001", kind: "sabotage", validated: true };
const EVENT_A = { eventId: "evt-1", type: "sabotage.injected" };

describe("readLedger / readAuditLog: applying amendments", () => {
  it("returns a plain file unchanged, each entry with an empty amendments list", () => {
    const path = fileOf(CASE_A);
    expect(readLedger(path)).toEqual([{ ...CASE_A, amendments: [] }]);
  });

  it("merges an amendment's change into its target and records the amendment", () => {
    const amendment = {
      kind: "amendment",
      amends: "FF-0001",
      at: "2026-11-10T17:00:00.000Z",
      change: { alsoBreaks: [{ invariantId: "INV-AUTH-001" }] },
      reason: "the collateral was adjudicated",
      evidence: "examples/FF-0001.json#collateral",
    };
    const path = fileOf(CASE_A, amendment);
    const [entry] = readLedger(path);
    expect(entry?.alsoBreaks).toEqual([{ invariantId: "INV-AUTH-001" }]);
    expect(entry?.amendments).toEqual([amendment]);
  });

  it("applies two amendments to the same entry, in file order", () => {
    const first = {
      kind: "amendment",
      amends: "FF-0001",
      at: "t1",
      change: { note: "first" },
      reason: "r1",
      evidence: "e1",
    };
    const second = {
      kind: "amendment",
      amends: "FF-0001",
      at: "t2",
      change: { note: "second" },
      reason: "r2",
      evidence: "e2",
    };
    const path = fileOf(CASE_A, first, second);
    const [entry] = readLedger(path);
    expect(entry?.note).toBe("second");
    expect(entry?.amendments).toEqual([first, second]);
  });

  it("applies amendments to audit events by eventId", () => {
    const amendment = {
      kind: "amendment",
      amends: "evt-1",
      at: "t1",
      change: { note: "corrected" },
      reason: "r1",
      evidence: "e1",
    };
    const path = fileOf(EVENT_A, amendment);
    const [entry] = readAuditLog(path);
    expect(entry?.note).toBe("corrected");
  });

  it("leaves an amendment unapplied when its target is missing, same as ledgerProblems reports", () => {
    const amendment = {
      kind: "amendment",
      amends: "FF-9999",
      at: "t1",
      change: { note: "x" },
      reason: "r",
      evidence: "e",
    };
    const path = fileOf(CASE_A, amendment);
    const [entry] = readLedger(path);
    expect(entry?.note).toBeUndefined();
  });

  it("targets one audit event by eventId, never the other event sharing its caseId (Qodo on PR 135)", () => {
    const first = { eventId: "evt-1", caseId: "FF-0001", type: "sabotage.injected" };
    const second = { eventId: "evt-2", caseId: "FF-0001", type: "review.recorded" };
    const amendment = {
      kind: "amendment",
      amends: "evt-2",
      at: "t1",
      change: { note: "fixed" },
      reason: "r",
      evidence: "e",
    };
    const path = fileOf(first, second, amendment);
    const [a, b] = readAuditLog(path);
    expect(a?.note).toBeUndefined();
    expect(b?.note).toBe("fixed");
  });

  it("leaves an amendment unapplied when its target id is held by more than one entry", () => {
    const amendment = {
      kind: "amendment",
      amends: "FF-0001",
      at: "t1",
      change: { note: "x" },
      reason: "r",
      evidence: "e",
    };
    const path = fileOf(CASE_A, CASE_A, amendment);
    const [first, second] = readLedger(path);
    expect(first?.note).toBeUndefined();
    expect(second?.note).toBeUndefined();
  });

  it("applies a change naming its own field 'amendments' without crashing, and still returns the real list", () => {
    const amendment = {
      kind: "amendment",
      amends: "FF-0001",
      at: "t1",
      change: { amendments: null },
      reason: "r",
      evidence: "e",
    };
    const path = fileOf(CASE_A, amendment);
    const [entry] = readLedger(path);
    expect(entry?.amendments).toEqual([amendment]);
  });
});

describe("ledgerProblems", () => {
  it("is empty for a file with no amendments", () => {
    expect(ledgerProblems(fileOf(CASE_A))).toEqual([]);
  });

  it("is empty for a sound amendment, including the same entry amended twice", () => {
    const sound = (note: string) => ({
      kind: "amendment",
      amends: "FF-0001",
      at: "t1",
      change: { note },
      reason: "r",
      evidence: "e",
    });
    expect(ledgerProblems(fileOf(CASE_A, sound("first"), sound("second")))).toEqual([]);
  });

  it("refuses an amendment naming an entry the file doesn't hold", () => {
    const path = fileOf(CASE_A, {
      kind: "amendment",
      amends: "FF-9999",
      at: "t1",
      change: { note: "x" },
      reason: "r",
      evidence: "e",
    });
    expect(ledgerProblems(path)).toEqual(["amendment amending FF-9999: the file doesn't hold that entry"]);
  });

  it("refuses an amendment with no reason", () => {
    const path = fileOf(CASE_A, {
      kind: "amendment",
      amends: "FF-0001",
      at: "t1",
      change: { note: "x" },
      evidence: "e",
    });
    expect(ledgerProblems(path)).toEqual(["amendment amending FF-0001: has no reason"]);
  });

  it("refuses an amendment with no evidence", () => {
    const path = fileOf(CASE_A, { kind: "amendment", amends: "FF-0001", at: "t1", change: { note: "x" }, reason: "r" });
    expect(ledgerProblems(path)).toEqual(["amendment amending FF-0001: has no evidence"]);
  });

  it("refuses a whitespace-only reason or evidence the same as a missing one (Qodo on PR 135)", () => {
    const path = fileOf(CASE_A, {
      kind: "amendment",
      amends: "FF-0001",
      at: "t1",
      change: { note: "x" },
      reason: "   ",
      evidence: "\t",
    });
    expect(ledgerProblems(path)).toEqual([
      "amendment amending FF-0001: has no reason",
      "amendment amending FF-0001: has no evidence",
    ]);
  });

  it("refuses an id held by more than one entry, and the amendment naming it, instead of picking one (Qodo on PR 135)", () => {
    const path = fileOf(CASE_A, CASE_A, {
      kind: "amendment",
      amends: "FF-0001",
      at: "t1",
      change: { note: "x" },
      reason: "r",
      evidence: "e",
    });
    expect(ledgerProblems(path)).toEqual([
      "FF-0001 is held by more than one entry",
      "amendment amending FF-0001: that id is held by more than one entry, so the target is ambiguous",
    ]);
  });

  it("refuses an amendment that amends another amendment", () => {
    // The first amendment carries its own id, which is not part of the documented shape, but the
    // checker must still catch a second amendment that names it as a target.
    const first = {
      kind: "amendment",
      caseId: "amend-1",
      amends: "FF-0001",
      at: "t1",
      change: { note: "x" },
      reason: "r",
      evidence: "e",
    };
    const second = {
      kind: "amendment",
      amends: "amend-1",
      at: "t2",
      change: { note: "y" },
      reason: "r",
      evidence: "e",
    };
    const path = fileOf(CASE_A, first, second);
    expect(ledgerProblems(path)).toEqual(["amendment amending amend-1: that is itself an amendment"]);
  });

  it.each([["caseId"], ["eventId"], ["kind"], ["at"]])("refuses an amendment that changes %s", (field) => {
    const path = fileOf(CASE_A, {
      kind: "amendment",
      amends: "FF-0001",
      at: "t1",
      change: { [field]: "whatever" },
      reason: "r",
      evidence: "e",
    });
    expect(ledgerProblems(path)).toEqual([
      `amendment amending FF-0001: changes ${field}, which an amendment may not touch`,
    ]);
  });

  it("reports every problem an amendment has, not just the first", () => {
    const path = fileOf(CASE_A, { kind: "amendment", amends: "FF-0001", at: "t1", change: { kind: "control" } });
    expect(ledgerProblems(path)).toEqual([
      "amendment amending FF-0001: has no reason",
      "amendment amending FF-0001: has no evidence",
      "amendment amending FF-0001: changes kind, which an amendment may not touch",
    ]);
  });
});

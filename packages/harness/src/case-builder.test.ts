import { describe, expect, it } from "vitest";
import { type BuildInputs, buildCaseRecord, latestEvent } from "./case-builder.ts";
import { validateCaseRecord } from "./case-record.ts";
import type { LedgerEntry } from "./ledger.ts";
import type { Finding } from "./qodo-review.ts";

const COMMIT = "b".repeat(40);

function event(type: string, fields: Record<string, unknown> = {}): LedgerEntry {
  return { eventId: `${type}-id`, type, caseId: "FF-9100", at: "2026-11-05T00:00:00.000Z", amendments: [], ...fields };
}

function entry(kind: "sabotage" | "control"): LedgerEntry {
  return {
    caseId: "FF-9100",
    kind,
    templateId: "x-secret-v1",
    ...(kind === "sabotage" ? { invariantId: "INV-X-001", defectClass: "off-by-one" } : {}),
    targetRepo: "https://github.com/Owner/target.git",
    targetCommit: "a".repeat(40),
    injectionCommit: COMMIT,
    injectedFile: "src/x.ts",
    injectedLines: [10, 12],
    amendments: [],
  };
}

const FINDING: Finding = {
  id: "f1",
  file: "src/other.ts",
  lines: [1, 2],
  severity: "remediation_recommended",
  category: "Style",
  title: "A naming nit",
  description: "Something unrelated.",
};

/** One case's inputs: planted, reviewed (as `state` says) and adjudicated (as `disposition` says). */
function inputs(kind: "sabotage" | "control", disposition: string, reviewState: string, findings: Finding[]) {
  const events = [
    event(kind === "control" ? "control.injected" : "sabotage.injected"),
    event("review.recorded", {
      pr: { repo: "Owner/target", number: 9, url: "https://github.com/Owner/target/pull/9" },
      review: {
        reviewer: "qodo-code-review[bot]",
        path: "pr-comments",
        configVersion: "v1",
        reviewedCommit: COMMIT,
        reviewedAt: "2026-11-05T00:05:00.000Z",
        url: "https://github.com/Owner/target/pull/9#issuecomment-1",
      },
    }),
    event("case.adjudicated", { disposition, by: "Owner", at: "2026-11-05T00:10:00.000Z" }),
  ];
  const result: BuildInputs = {
    entry: entry(kind),
    events,
    findings,
    overlay: {},
    kindTerms: ["off by one"],
    reviewState,
  };
  return result;
}

/** What a record built from these inputs would be refused for: a build error, or the record's problems. */
function problemsOf(i: BuildInputs): string[] {
  let record: Record<string, unknown>;
  try {
    record = buildCaseRecord(i);
  } catch (e) {
    return [(e as Error).message];
  }
  return validateCaseRecord(record);
}

describe("the five records a publish gate must refuse (AUD-M1)", () => {
  it("a planted bug confirmed missed on a review that never finished", () => {
    expect(problemsOf(inputs("sabotage", "confirmed_missed", "review incomplete", []))).toEqual([
      expect.stringContaining('"review incomplete", not "complete", so confirmed_missed'),
    ]);
  });

  it("a planted bug confirmed missed on a review Qodo skipped", () => {
    expect(problemsOf(inputs("sabotage", "confirmed_missed", "skipped by Qodo", []))).toEqual([
      expect.stringContaining('"skipped by Qodo", not "complete"'),
    ]);
  });

  it("a control confirmed clean on a review that never finished", () => {
    expect(problemsOf(inputs("control", "confirmed_clean", "review incomplete", []))).toEqual([
      expect.stringContaining("so confirmed_clean can't stand on it"),
    ]);
  });

  it("a control confirmed clean although Qodo raised a finding", () => {
    expect(problemsOf(inputs("control", "confirmed_clean", "complete", [FINDING]))).toEqual([
      "confirmed_clean, but Qodo raised 1 finding(s): a clean control has none",
    ]);
  });

  it("a control confirmed a false alarm although Qodo raised nothing", () => {
    expect(problemsOf(inputs("control", "confirmed_false_alarm", "complete", []))).toEqual([
      "confirmed_false_alarm, but Qodo raised no finding to be a false alarm",
    ]);
  });

  it("still builds the honest versions of each", () => {
    expect(problemsOf(inputs("sabotage", "review_incomplete", "review incomplete", []))).toEqual([]);
    expect(problemsOf(inputs("sabotage", "confirmed_missed", "complete", []))).toEqual([]);
    expect(problemsOf(inputs("control", "review_incomplete", "skipped by Qodo", []))).toEqual([]);
    expect(problemsOf(inputs("control", "confirmed_clean", "complete", []))).toEqual([]);
    expect(problemsOf(inputs("control", "confirmed_false_alarm", "complete", [FINDING]))).toEqual([]);
  });

  it("reads a save with no state as unfinished, and a legacy review (no save) by its verdict alone", () => {
    expect(problemsOf(inputs("sabotage", "confirmed_missed", "", []))[0]).toContain('state is "", not "complete"');
    expect(problemsOf({ ...inputs("sabotage", "confirmed_missed", "x", []), reviewState: null })).toEqual([]);
  });
});

describe("latestEvent (AUD-N8)", () => {
  const verdict = (eventId: string, at: string) => event("case.adjudicated", { eventId, at });

  it("compares times as instants, not as text", () => {
    const later = verdict("later", "2026-11-05T11:00:00.500Z");
    const earlier = verdict("earlier", "2026-11-05T11:00:00Z");
    expect(latestEvent([later, earlier], ["case.adjudicated"], "s").eventId).toBe("later");
    const offset = verdict("offset", "2026-11-05T12:30:00+01:00");
    const utc = verdict("utc", "2026-11-05T12:00:00Z");
    expect(latestEvent([offset, utc], ["case.adjudicated"], "s").eventId).toBe("utc");
  });

  it("gives a tie to the later line, and refuses an event with no readable time", () => {
    const at = "2026-11-05T11:00:00.000Z";
    expect(latestEvent([verdict("first", at), verdict("second", at)], ["case.adjudicated"], "s").eventId).toBe(
      "second",
    );
    expect(() => latestEvent([verdict("a", at), verdict("b", "soon")], ["case.adjudicated"], "s")).toThrow(
      /no readable time/,
    );
  });
});

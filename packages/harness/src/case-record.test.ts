import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findLeaks, validateCaseRecord } from "./case-record.ts";

const root = join(import.meta.dirname, "../../..");
const examples = readdirSync(join(root, "examples"))
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({ name, text: readFileSync(join(root, "examples", name), "utf8") }));

const ff0001 = () => JSON.parse(readFileSync(join(root, "examples/FF-0001.json"), "utf8"));

/** Every template's planted change, so no record can leak a template's exact text. */
function templateSnippets(): string[] {
  const seed = join(root, "templates/seed");
  return readdirSync(seed).flatMap((id) => {
    const template = JSON.parse(readFileSync(join(seed, id, "template.json"), "utf8"));
    return [template.find, template.replace].map((s: string) => s.trim());
  });
}

/** A truthful clean control: a harmless change, reviewed, with no planted bug. */
function controlRecord() {
  const { injection: _injection, detection: _detection, collateral: _collateral, ...rest } = ff0001();
  return {
    ...rest,
    caseId: "FF-0099",
    kind: "control",
    findings: [],
    human: { ...rest.human, disposition: "confirmed_clean" },
  };
}

describe("published case records", () => {
  it("has at least one record", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples)("$name is valid", ({ text }) => {
    expect(validateCaseRecord(JSON.parse(text))).toEqual([]);
  });

  it.each(examples)("$name leaves out private fields and template text", ({ text }) => {
    expect(findLeaks(text)).toEqual([]);
    for (const snippet of templateSnippets()) {
      expect(text).not.toContain(snippet);
    }
  });

  it.each(examples)("$name is named after its case id", ({ name, text }) => {
    expect(name).toBe(`${JSON.parse(text).caseId}.json`);
  });
});

describe("validateCaseRecord", () => {
  it("rejects an unknown field", () => {
    expect(validateCaseRecord({ ...ff0001(), proofTest: "x" })).not.toEqual([]);
  });

  it("rejects a record without the owner's verdict", () => {
    const { human: _human, ...record } = ff0001();
    expect(validateCaseRecord(record)).not.toEqual([]);
  });

  it("accepts a clean control without planted-bug details", () => {
    expect(validateCaseRecord(controlRecord())).toEqual([]);
  });

  it("rejects a control that claims a planted bug", () => {
    expect(validateCaseRecord({ ...controlRecord(), injection: ff0001().injection })).not.toEqual([]);
  });

  it("rejects a bug case without planted-bug details", () => {
    const { injection: _injection, ...record } = ff0001();
    expect(validateCaseRecord(record)).not.toEqual([]);
  });

  it("rejects a catch that names a finding the record doesn't have", () => {
    const record = ff0001();
    record.detection.matchedFindingIds = ["qodo:does-not-exist"];
    expect(validateCaseRecord(record)).not.toEqual([]);
  });

  it("rejects a catch when a match criterion failed", () => {
    const record = ff0001();
    record.detection.match.lines.pass = false;
    expect(validateCaseRecord(record)).not.toEqual([]);
  });

  it("rejects a miss that still names matched findings", () => {
    const record = ff0001();
    record.detection.caught = false;
    expect(validateCaseRecord(record)).not.toEqual([]);
  });

  it("rejects a detected disposition on a missed case", () => {
    const record = ff0001();
    record.detection = { ...record.detection, caught: false, matchedFindingIds: [] };
    record.detection.match.kind.pass = false;
    expect(validateCaseRecord(record)).not.toEqual([]);
  });

  it("rejects a matched finding whose file differs from the injected file", () => {
    const record = ff0001();
    record.findings[0].file = "src/bookings/other.ts";
    expect(validateCaseRecord(record)).not.toEqual([]);
  });

  it("rejects a matched finding whose lines don't overlap the injected lines", () => {
    const record = ff0001();
    record.findings[0].lines = [100, 100];
    expect(validateCaseRecord(record)).not.toEqual([]);
  });

  it("rejects a reviewedCommit that differs from the injected commit", () => {
    const record = ff0001();
    record.review.reviewedCommit = "a".repeat(40);
    expect(validateCaseRecord(record)).not.toEqual([]);
  });

  it("accepts a record where a null-placement finding isn't matched", () => {
    const record = ff0001();
    record.findings.push({
      id: "qodo:unplaced",
      file: null,
      lines: null,
      category: "Other",
      severity: "low",
      summary: "Unrelated finding Qodo didn't place anywhere.",
    });
    expect(validateCaseRecord(record)).toEqual([]);
  });

  it("rejects a record that lists a null-placement finding as matched", () => {
    const record = ff0001();
    record.findings.push({
      id: "qodo:unplaced",
      file: null,
      lines: null,
      category: "Other",
      severity: "low",
      summary: "Unrelated finding Qodo didn't place anywhere.",
    });
    record.detection.matchedFindingIds.push("qodo:unplaced");
    expect(validateCaseRecord(record)).not.toEqual([]);
  });
});

describe("findLeaks", () => {
  it.each([
    "see private/cases/FF-0001.json",
    "see .faultforge/answers.jsonl",
    "see .faultforge\\answers.jsonl",
    "raw-artifacts/FF-0001/log",
    "proofTest",
  ])("flags %s", (text) => {
    expect(findLeaks(text)).not.toEqual([]);
  });

  it("allows ordinary text", () => {
    expect(findLeaks("Qodo flagged src/bookings/create.ts line 33")).toEqual([]);
  });
});

describe("validateCaseRecord: what the schema can't say (Qodo on PR 128)", () => {
  it("rejects a finding id that appears more than once", () => {
    const record = ff0001();
    record.findings.push({ ...record.findings[0], file: null, lines: null });
    expect(validateCaseRecord(record)).toEqual(
      expect.arrayContaining([expect.stringMatching(/appears more than once/)]),
    );
  });

  it("rejects a line range whose end comes before its start, in a finding and in the injection", () => {
    const record = ff0001();
    record.findings[0].lines = [40, 30];
    expect(validateCaseRecord(record)).toEqual(
      expect.arrayContaining([expect.stringMatching(/end comes before its start/)]),
    );
    const other = ff0001();
    other.injection.lines = [40, 30];
    expect(validateCaseRecord(other)).toEqual(expect.arrayContaining([expect.stringMatching(/injection\.lines/)]));
  });
});

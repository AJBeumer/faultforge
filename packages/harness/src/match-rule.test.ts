import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyMatchRule,
  type FindingMatch,
  type Injection,
  isRange,
  type MatchFinding,
  type MatchRuleResult,
  overlaps,
} from "./match-rule.ts";

const root = join(import.meta.dirname, "../../..");

const injection: Injection = { file: "src/bookings/create.ts", lines: [33, 33] };
const kindTerms = ["idempotency", "replay"];

/** The result for a single finding passed in, asserting one was actually returned. */
function only(result: MatchRuleResult): FindingMatch {
  const [first] = result.findings;
  if (!first) throw new Error("expected at least one finding result");
  return first;
}

function finding(overrides: Partial<MatchFinding> = {}): MatchFinding {
  return {
    id: "qodo:1",
    file: "src/bookings/create.ts",
    lines: [33, 33],
    title: "Booking replays expose another user's data",
    summary: "A repeat request creates a second booking.",
    category: "Security",
    ...overrides,
  };
}

describe("applyMatchRule: file criterion", () => {
  it("passes on the same file", () => {
    const result = applyMatchRule(injection, [finding()], kindTerms);
    expect(only(result).file).toEqual({
      pass: true,
      detail: "the finding names src/bookings/create.ts, the changed file",
    });
  });

  it("fails on a different file", () => {
    const result = applyMatchRule(injection, [finding({ file: "src/bookings/other.ts" })], kindTerms);
    expect(only(result).file.pass).toBe(false);
  });

  it("passes when the same file is spelled with a leading ./", () => {
    const result = applyMatchRule(injection, [finding({ file: "./src/bookings/create.ts" })], kindTerms);
    expect(only(result).file.pass).toBe(true);
  });

  it("fails with a 'placed nowhere' detail when file is null", () => {
    const result = applyMatchRule(injection, [finding({ file: null })], kindTerms);
    expect(only(result).file.pass).toBe(false);
    expect(only(result).file.detail).toContain("Qodo placed it nowhere");
  });
});

describe("applyMatchRule: lines criterion", () => {
  it("counts overlapping ranges as passing", () => {
    const result = applyMatchRule({ file: injection.file, lines: [10, 12] }, [finding({ lines: [12, 20] })], kindTerms);
    expect(only(result).lines.pass).toBe(true);
  });

  it("counts touching ranges as passing", () => {
    const result = applyMatchRule({ file: injection.file, lines: [10, 12] }, [finding({ lines: [12, 12] })], kindTerms);
    expect(only(result).lines.pass).toBe(true);
  });

  it("counts disjoint ranges as failing", () => {
    const result = applyMatchRule({ file: injection.file, lines: [10, 12] }, [finding({ lines: [13, 20] })], kindTerms);
    expect(only(result).lines.pass).toBe(false);
  });

  it("fails with a 'placed nowhere' detail when lines is null", () => {
    const result = applyMatchRule(injection, [finding({ lines: null })], kindTerms);
    expect(only(result).lines.pass).toBe(false);
    expect(only(result).lines.detail).toContain("Qodo placed it nowhere");
  });

  it("never throws on null placement", () => {
    expect(() => applyMatchRule(injection, [finding({ file: null, lines: null })], kindTerms)).not.toThrow();
  });
});

describe("applyMatchRule: kind criterion", () => {
  it("passes when a term is in the title", () => {
    const result = applyMatchRule(
      injection,
      [finding({ title: "Replay creates a duplicate booking", summary: "", category: "" })],
      kindTerms,
    );
    expect(only(result).kind.pass).toBe(true);
  });

  it("passes when a term is in the summary", () => {
    const result = applyMatchRule(
      injection,
      [finding({ title: "", summary: "Breaks idempotency on repeat requests", category: "" })],
      kindTerms,
    );
    expect(only(result).kind.pass).toBe(true);
  });

  it("passes when a term is in the category", () => {
    const result = applyMatchRule(injection, [finding({ title: "", summary: "", category: "Idempotency" })], kindTerms);
    expect(only(result).kind.pass).toBe(true);
  });

  it("fails when no term is present", () => {
    const result = applyMatchRule(
      injection,
      [finding({ title: "Off by one", summary: "Loop runs one too many times", category: "Bug" })],
      kindTerms,
    );
    expect(only(result).kind.pass).toBe(false);
  });
});

describe("applyMatchRule: line width and overall result", () => {
  it("reports the width of the finding's own line range", () => {
    const result = applyMatchRule(injection, [finding({ lines: [10, 12] })], kindTerms);
    expect(only(result).lineWidth).toBe(3);
  });

  it("reports a null width when lines is null", () => {
    const result = applyMatchRule(injection, [finding({ lines: null })], kindTerms);
    expect(only(result).lineWidth).toBeNull();
  });

  it("catches only when all three criteria pass", () => {
    const result = applyMatchRule(injection, [finding({ file: "other.ts" })], kindTerms);
    expect(result.caught).toBe(false);
    expect(result.matchedFindingIds).toEqual([]);
  });

  it("matches a finding that passes every criterion", () => {
    const result = applyMatchRule(injection, [finding()], kindTerms);
    expect(result.caught).toBe(true);
    expect(result.matchedFindingIds).toEqual(["qodo:1"]);
  });
});

describe("applyMatchRule against the published FF-0001 record", () => {
  it("gets the same three passes and caught: true as the record holds", () => {
    const record = JSON.parse(readFileSync(join(root, "examples/FF-0001.json"), "utf8"));
    const template = JSON.parse(
      readFileSync(join(root, `templates/seed/${record.injection.templateId}/template.json`), "utf8"),
    );
    const result = applyMatchRule(record.injection, record.findings, template.match.kindTerms);
    expect(result.caught).toBe(record.detection.caught);
    expect(result.matchedFindingIds).toEqual(record.detection.matchedFindingIds);
    expect(only(result).file.pass).toBe(record.detection.match.file.pass);
    expect(only(result).lines.pass).toBe(record.detection.match.lines.pass);
    expect(only(result).kind.pass).toBe(record.detection.match.kind.pass);
  });
});

describe("applyMatchRule: ranges that aren't ranges (Qodo on PR 128)", () => {
  it("fails the lines criterion for a reversed finding range and reports no width", () => {
    const reversed = finding({ lines: [20, 10], title: "Replay", summary: "", category: "" });
    const result = applyMatchRule({ file: injection.file, lines: [5, 25] }, [reversed], kindTerms);
    expect(only(result).lines.pass).toBe(false);
    expect(only(result).lines.detail).toMatch(/end comes before the start/);
    expect(only(result).lineWidth).toBeNull();
    expect(result.caught).toBe(false);
  });

  it("overlaps() is false for a reversed range on either side", () => {
    expect(overlaps([20, 10], [5, 25])).toBe(false);
    expect(overlaps([5, 25], [20, 10])).toBe(false);
    expect(overlaps([5, 25], [10, 20])).toBe(true);
  });
});

describe("applyMatchRule: behaviour pinned after the 13 November audit (#188)", () => {
  const finding = (overrides: Partial<MatchFinding> = {}): MatchFinding => ({
    id: "qodo:1",
    file: "src/bookings/create.ts",
    lines: [33, 33],
    title: "Booking replays expose another user's data",
    summary: "A repeat request creates a second booking.",
    category: "Security",
    ...overrides,
  });

  it("does not catch a finding on the right file and lines that describes another kind of problem", () => {
    const wrongKind = finding({ title: "Off by one", summary: "Loop runs one too many times", category: "Bug" });
    const result = applyMatchRule(injection, [wrongKind], kindTerms);
    expect(only(result)).toMatchObject({ file: { pass: true }, lines: { pass: true }, kind: { pass: false } });
    expect(only(result).matched).toBe(false);
    expect(result.caught).toBe(false);
    expect(result.matchedFindingIds).toEqual([]);
  });

  it("does not catch a finding of the right file and kind whose valid range misses the changed lines", () => {
    const result = applyMatchRule(injection, [finding({ lines: [40, 45] })], kindTerms);
    expect(only(result).lines.pass).toBe(false);
    expect(result.caught).toBe(false);
  });

  it("compares kind terms without regard to case, on the template's side too", () => {
    const result = applyMatchRule(
      injection,
      [finding({ title: "a replay creates a duplicate booking", summary: "", category: "" })],
      ["Replay"],
    );
    expect(only(result).kind).toEqual({ pass: true, detail: '"Replay" found in title' });
    expect(result.caught).toBe(true);
  });

  it("reads a file path with either separator, on both sides", () => {
    expect(only(applyMatchRule(injection, [finding({ file: "src\\bookings\\create.ts" })], kindTerms)).file.pass).toBe(
      true,
    );
    const backslashKey: Injection = { file: ".\\src\\bookings\\create.ts", lines: [33, 33] };
    expect(only(applyMatchRule(backslashKey, [finding()], kindTerms)).file.pass).toBe(true);
  });

  it("counts lines from 1: a range starting at line 0 is no range and overlaps nothing", () => {
    expect(isRange([0, 3])).toBe(false);
    expect(isRange([0, 0])).toBe(false);
    expect(isRange([1, 1])).toBe(true);
    expect(overlaps([0, 2], [1, 5])).toBe(false);
    const result = applyMatchRule({ file: injection.file, lines: [1, 5] }, [finding({ lines: [0, 2] })], kindTerms);
    expect(only(result).lines.pass).toBe(false);
    expect(only(result).lineWidth).toBeNull();
    expect(result.caught).toBe(false);
  });
});

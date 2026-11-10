import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyMatchRule,
  type FindingMatch,
  type Injection,
  type MatchFinding,
  type MatchRuleResult,
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

import { describe, expect, it } from "vitest";
import { type ApprovalFacts, blockingLevels, guardedFiles, judge, labelProblem, predict } from "./approval-rule.ts";

const GUARDS = [".claude/hooks/**"];

describe("guarded paths", () => {
  it("matches files under a guarded folder, at any depth, and nothing beside it", () => {
    expect(
      guardedFiles([".claude/hooks/a.ts", ".claude/hooks/shell/b.ts", ".claude/hooksy/c.ts", "src/d.ts"], GUARDS),
    ).toEqual([".claude/hooks/a.ts", ".claude/hooks/shell/b.ts"]);
  });

  it("reads Windows separators as the same path", () => {
    expect(guardedFiles([".claude\\hooks\\a.ts"], GUARDS)).toEqual([".claude\\hooks\\a.ts"]);
  });

  it("predicts a person for a guarded path, a PR touching both, and the label only for an unguarded one", () => {
    expect(predict([".claude/hooks/a.ts"], GUARDS).verdict).toBe("held-for-human");
    expect(predict(["src/x.ts", ".claude/hooks/a.ts"], GUARDS)).toEqual({
      verdict: "held-for-human",
      guarded: [".claude/hooks/a.ts"],
    });
    expect(predict(["src/x.ts"], GUARDS)).toEqual({ verdict: "eligible-if-clean", guarded: [] });
    expect(predict(["src/x.ts"], []).verdict).toBe("eligible-if-clean");
  });
});

describe("the label's condition", () => {
  const flag = ["informational"];
  it("lets only the labels the gate flags through", () => {
    expect(blockingLevels(["informational", "informational"], flag)).toEqual([]);
    expect(blockingLevels(["remediation_recommended", "informational", "action_required"], flag)).toEqual([
      "remediation_recommended",
      "action_required",
    ]);
  });

  it("stops on a label it doesn't know, or none", () => {
    expect(blockingLevels(["high", undefined, null], flag)).toEqual(["high", "none", "none"]);
  });
});

describe("judging the label against our checks", () => {
  const facts = (over: Partial<ApprovalFacts> = {}): ApprovalFacts => ({
    labelled: true,
    labelProblem: null,
    guarded: [],
    reviewClean: true,
    gateMet: true,
    ciGreen: true,
    ...over,
  });

  it("verifies a label that every check backs", () => {
    expect(judge(facts()).verdict).toBe("approved-verified");
  });

  it("holds an unlabelled guarded PR for a person, even with a clean review", () => {
    expect(judge(facts({ labelled: false, guarded: [".claude/hooks/a.ts"] })).verdict).toBe("held-for-human");
  });

  it("calls an unlabelled PR with findings not eligible", () => {
    expect(judge(facts({ labelled: false, reviewClean: false })).verdict).toBe("not-eligible");
  });

  it("flags a label on a guarded path, an unclean or unreviewed head, a failed gate or red CI", () => {
    for (const over of [
      { guarded: ["x"] },
      { reviewClean: false },
      { gateMet: false },
      { ciGreen: false },
      { labelProblem: "added by a person" },
    ]) {
      expect(judge(facts(over)).verdict).toBe("disagree");
    }
  });

  it("flags a missing label on a head that meets the condition", () => {
    const result = judge(facts({ labelled: false }));
    expect(result.verdict).toBe("disagree");
    expect(result.reasons[0]).toMatch(/has no label/);
  });
});

describe("who added the label, and when", () => {
  const BOT = "qodo-code-review[bot]";
  const START = "2026-11-23T12:00:00Z";
  const add = (login: string, at: string) => ({ event: "labeled", actor: { login }, created_at: at });

  it("accepts the app's add once the head's review began, judging the last add only", () => {
    expect(labelProblem([add(BOT, "2026-11-23T12:01:00Z")], BOT, START)).toBeNull();
    expect(
      labelProblem([add("someone", "2026-11-23T11:00:00Z"), add(BOT, "2026-11-23T12:01:00Z")], BOT, START),
    ).toBeNull();
  });

  it("refuses a person's add, an add before the review began, and unknown times", () => {
    expect(labelProblem([add("someone", "2026-11-23T12:01:00Z")], BOT, START)).toMatch(/added by someone/);
    expect(labelProblem([add(BOT, "2026-11-23T11:59:59Z")], BOT, START)).toMatch(/older head/);
    expect(labelProblem([add(BOT, "2026-11-23T12:01:00Z")], BOT, undefined)).toMatch(/unknown/);
    expect(labelProblem([], BOT, START)).toMatch(/no add/);
  });
});

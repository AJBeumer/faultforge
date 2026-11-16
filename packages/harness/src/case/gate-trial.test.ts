import { describe, expect, it } from "vitest";
import type { QualityGate } from "../shared/factory-config.ts";
import {
  type BuilderDecision,
  builderPrompt,
  builderPromptProblems,
  evidencePathProblem,
  judge,
  type LoopDeps,
  type ProofResult,
  parseDecisions,
  runLoop,
  type TrialFinding,
  type TrialReview,
} from "./gate-trial.ts";

const GATE: QualityGate = {
  fix: ["action_required", "remediation_recommended"],
  flag: ["informational"],
  maxRounds: 3,
};
const HIGH_ONLY: QualityGate = {
  fix: ["action_required"],
  flag: ["remediation_recommended", "informational"],
  maxRounds: 3,
};

const finding = (id: string, severity: string | null): TrialFinding => ({
  id,
  severity,
  title: `Finding ${id}`,
  file: "src/a.ts",
  lines: [1, 2],
  description: "It breaks.",
});
const review = (open: TrialFinding[], complete = true): TrialReview => ({ complete, open, evidence: "saved" });

/** A loop over scripted reviews; the builder answers "fixed" for everything unless told otherwise. */
function scripted(reviews: TrialReview[], decide?: (mustFix: TrialFinding[]) => BuilderDecision[], passes = false) {
  const built: string[][] = [];
  const deps: LoopDeps = {
    review: async (round) => reviews[round - 1] ?? (reviews.at(-1) as TrialReview),
    build: async (_round, mustFix) => {
      built.push(mustFix.map((f) => f.id));
      return decide ? decide(mustFix) : mustFix.map((f) => ({ id: f.id, decision: "fixed" as const }));
    },
    evidencePasses: async () => passes,
  };
  return { deps, built };
}

describe("runLoop", () => {
  it("is done at once, without calling the builder, when the opening review meets the gate", async () => {
    const { deps, built } = scripted([review([finding("low", "informational")])]);
    const outcome = await runLoop(GATE, deps);
    expect(outcome.status).toBe("done");
    expect(outcome.rounds).toHaveLength(1);
    expect(outcome.rounds[0]?.gateMet).toBe(true);
    expect(built).toEqual([]);
  });

  it("hands the builder only what the gate says to fix, and is done when the next review is clean", async () => {
    const { deps, built } = scripted([
      review([finding("m", "remediation_recommended"), finding("low", "informational")]),
      review([finding("low", "informational")]),
    ]);
    const outcome = await runLoop(GATE, deps);
    expect(outcome.status).toBe("done");
    expect(built).toEqual([["m"]]);
    expect(outcome.rounds[0]?.decisions).toEqual([{ id: "m", decision: "fixed" }]);
  });

  it("under a gate that fixes only the first label, a remediation-recommended finding ends the loop as done", async () => {
    const { deps, built } = scripted([review([finding("m", "remediation_recommended")])]);
    const outcome = await runLoop(HIGH_ONLY, deps);
    expect(outcome.status).toBe("done");
    expect(built).toEqual([]);
  });

  it("is not done when the review was incomplete, even with nothing open", async () => {
    const outcome = await runLoop(GATE, scripted([review([], false)]).deps);
    expect(outcome.status).toBe("not done: the review was incomplete");
    expect(outcome.rounds[0]?.gateMet).toBe(false);
  });

  it("stops when a round closed nothing that had to be fixed", async () => {
    const open = [finding("m", "remediation_recommended")];
    const { deps, built } = scripted([review(open), review(open)]);
    const outcome = await runLoop(GATE, deps);
    expect(outcome.status).toBe("not done: a round closed nothing that had to be fixed");
    expect(built).toHaveLength(1);
  });

  it("stops at the round limit without a further fix", async () => {
    const { deps, built } = scripted([
      review([finding("a", "action_required")]),
      review([finding("b", "action_required")]),
      review([finding("c", "action_required")]),
    ]);
    const outcome = await runLoop(GATE, deps);
    expect(outcome.status).toBe("not done: the round limit was reached");
    expect(outcome.rounds).toHaveLength(3);
    expect(built).toEqual([["a"], ["b"]]);
  });

  it("treats a finding with an unknown label as one to act on", async () => {
    const { deps, built } = scripted([review([finding("u", "urgent")]), review([])]);
    const outcome = await runLoop(GATE, deps);
    expect(built).toEqual([["u"]]);
    expect(outcome.status).toBe("done");
  });

  it("ends as the owner's decision when a dispute comes with a test that passes", async () => {
    const dispute = (mustFix: TrialFinding[]) =>
      mustFix.map((f) => ({ id: f.id, decision: "disputed" as const, evidenceTest: "test/not-so.test.ts" }));
    const { deps } = scripted([review([finding("m", "remediation_recommended")])], dispute, true);
    const outcome = await runLoop(GATE, deps);
    expect(outcome.status).toBe("not done: a finding is disputed and the owner must decide");
    expect(outcome.rounds[0]?.disputesWithoutProof).toEqual([]);
  });

  it("counts a dispute without a passing test as an open finding, never as settled", async () => {
    const dispute = (mustFix: TrialFinding[]) => mustFix.map((f) => ({ id: f.id, decision: "disputed" as const }));
    const open = [finding("m", "remediation_recommended")];
    const { deps } = scripted([review(open), review(open)], dispute, false);
    const outcome = await runLoop(GATE, deps);
    expect(outcome.rounds[0]?.disputesWithoutProof).toEqual(["m"]);
    expect(outcome.status).toBe("not done: a round closed nothing that had to be fixed");
  });
});

describe("judge", () => {
  const own = (before: ProofResult["before"], after: ProofResult["after"]): ProofResult => ({
    invariantId: "INV-OWN",
    own: true,
    before,
    after,
  });
  const other = (before: ProofResult["before"], after: ProofResult["after"]): ProofResult => ({
    invariantId: "INV-OTHER",
    own: false,
    before,
    after,
  });

  it("separates a gate that was met with the defect gone from one met with the defect still there", () => {
    expect(judge("done", [own("fail", "pass"), other("pass", "pass")], false).result).toBe("gate met, defect gone");
    expect(judge("done", [own("fail", "fail"), other("pass", "pass")], false).result).toBe("gate met, defect survived");
  });

  it("reports a loop that said not done with what the proof shows", () => {
    const status = "not done: the round limit was reached";
    expect(judge(status, [own("fail", "fail")], false).result).toBe("not done, defect survived");
    expect(judge(status, [own("fail", "pass")], false).result).toBe("not done, defect gone");
  });

  it("names a proof that passed before the loop and fails after it as damage", () => {
    const verdict = judge("done", [own("fail", "pass"), other("pass", "fail")], false);
    expect(verdict.result).toBe("gate met, defect gone");
    expect(verdict.damage).toEqual(["INV-OTHER"]);
    expect(verdict.note).toBe("a fix broke a proof");
  });

  it("judges a control by damage alone", () => {
    expect(judge("done", [other("pass", "pass")], true)).toMatchObject({
      result: "gate met, nothing broken",
      damage: [],
    });
    expect(judge("done", [other("pass", "fail")], true).damage).toEqual(["INV-OTHER"]);
    expect(judge("not done: the review was incomplete", [other("pass", "pass")], true).result).toBe(
      "not done, nothing broken",
    );
  });

  it("claims nothing when a proof couldn't run or didn't start as expected", () => {
    expect(judge("done", [own("not_run", "pass")], false).result).toBe("inconclusive");
    expect(judge("done", [own("fail", "not_run")], false).result).toBe("inconclusive");
    expect(judge("done", [own("pass", "pass")], false).result).toBe("inconclusive");
    expect(judge("done", [other("pass", "pass")], false).result).toBe("inconclusive");
    expect(judge("done", [other("fail", "fail")], true).result).toBe("inconclusive");
  });
});

describe("the builder's instructions", () => {
  const ticket = {
    url: "https://github.com/owner/app/issues/40",
    title: "Validate a request before reading the store",
    body: "### What\nValidate first.\n\n### Acceptance criteria\n- [ ] Existing tests continue to pass.",
  };

  it("hold the ticket, the gate and each finding, and no word that gives the lab away", () => {
    const prompt = builderPrompt(ticket, GATE, [finding("f1", "remediation_recommended")]);
    expect(prompt).toContain("The task: Validate a request before reading the store");
    expect(prompt).toContain("id f1");
    expect(prompt).toContain("label: remediation_recommended (Medium)");
    expect(prompt).toContain("where: src/a.ts lines 1-2");
    expect(prompt).toContain("fix every valid open finding labelled action_required (High)");
    expect(builderPromptProblems(prompt)).toEqual([]);
  });

  it("are refused when a finding's text or the ticket would carry a giveaway word", () => {
    const leaky = builderPrompt({ ...ticket, body: "This is a planted bug from FaultForge." }, GATE, []);
    const problems = builderPromptProblems(leaky);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toMatch(/planted/);
  });

  it("keeps a long or multi-line finding description to one bounded line", () => {
    const long = { ...finding("f1", "action_required"), description: `a\nb\n${"x".repeat(5000)}` };
    const detail = builderPrompt(ticket, GATE, [long])
      .split("\n")
      .find((l) => l.trim().startsWith("detail:"));
    expect(detail?.length).toBeLessThan(1600);
    expect(detail).toContain("a b x");
  });
});

describe("parseDecisions", () => {
  it("reads the last DECISIONS line and keeps only findings that were listed", () => {
    const reply = [
      "Working…",
      'DECISIONS [{"id":"old","decision":"fixed"}]',
      "More work.",
      'DECISIONS [{"id":"f1","decision":"fixed","note":"added a test"},{"id":"f2","decision":"disputed","evidenceTest":"test/x.test.ts"},{"id":"ghost","decision":"fixed"},{"id":"f1","decision":"ignored"}]',
    ].join("\n");
    expect(parseDecisions(reply, ["f1", "f2"])).toEqual([
      { id: "f1", decision: "fixed", note: "added a test" },
      { id: "f2", decision: "disputed", evidenceTest: "test/x.test.ts" },
    ]);
  });

  it("gives no decisions for a reply without the line, or with one that isn't a JSON list", () => {
    expect(parseDecisions("all done", ["f1"])).toEqual([]);
    expect(parseDecisions("DECISIONS not json", ["f1"])).toEqual([]);
    expect(parseDecisions('DECISIONS {"id":"f1"}', ["f1"])).toEqual([]);
    expect(parseDecisions("DECISIONS [null, 3]", ["f1"])).toEqual([]);
  });
});

describe("evidencePathProblem", () => {
  it("accepts a test file inside the repository and refuses anything else", () => {
    expect(evidencePathProblem("test/not-so.test.ts")).toBeUndefined();
    expect(evidencePathProblem("src\\a.test.ts")).toBeUndefined();
    expect(evidencePathProblem("../outside.test.ts")).toMatch(/climbs out/);
    expect(evidencePathProblem("test/../../x.test.ts")).toMatch(/climbs out/);
    expect(evidencePathProblem("/etc/x.test.ts")).toMatch(/absolute/);
    expect(evidencePathProblem("C:/x.test.ts")).toMatch(/absolute/);
    expect(evidencePathProblem("src/a.ts")).toMatch(/not a test file/);
  });
});

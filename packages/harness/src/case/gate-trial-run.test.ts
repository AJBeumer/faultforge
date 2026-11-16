import { describe, expect, it } from "vitest";
import type { QualityGate } from "../shared/factory-config.ts";
import type { BuilderDecision, TrialFinding, TrialReview } from "./gate-trial.ts";
import {
  gateNamed,
  LeakRefusal,
  parseTrialArgs,
  runTrial,
  type TrialCase,
  type TrialIo,
  type TrialRecord,
  trialCase,
} from "./gate-trial-run.ts";

const SAVED: QualityGate = {
  fix: ["action_required", "remediation_recommended"],
  flag: ["informational"],
  maxRounds: 3,
};
const COMMIT = "a".repeat(40);
const TICKET = {
  url: "https://github.com/owner/app/issues/40",
  title: "Validate a request before reading the store",
  body: "### What\nValidate first.",
};

describe("parseTrialArgs", () => {
  it("takes a case id and a known gate name", () => {
    expect(parseTrialArgs(["FF-9001", "--gate", "saved"])).toEqual({ caseId: "FF-9001", gate: "saved", keep: false });
    expect(parseTrialArgs(["FF-9001", "--gate", "first-label-only", "--keep"])).toEqual({
      caseId: "FF-9001",
      gate: "first-label-only",
      keep: true,
    });
  });

  it("refuses anything else", () => {
    expect(parseTrialArgs([])).toBeNull();
    expect(parseTrialArgs(["FF-9001"])).toBeNull();
    expect(parseTrialArgs(["FF-9001", "--gate", "loose"])).toBeNull();
    expect(parseTrialArgs(["not-a-case", "--gate", "saved"])).toBeNull();
    expect(parseTrialArgs(["FF-9001", "FF-9002", "--gate", "saved"])).toBeNull();
    expect(parseTrialArgs(["FF-9001", "--gate", "saved", "--other"])).toBeNull();
  });
});

describe("gateNamed", () => {
  it("gives the saved gate, or the saved gate fixing only its first label", () => {
    expect(gateNamed("saved", SAVED)).toBe(SAVED);
    expect(gateNamed("first-label-only", SAVED).fix).toEqual(["action_required"]);
  });
});

describe("trialCase", () => {
  const truth = [
    { caseId: "FF-9001", kind: "sabotage", templateId: "made-up-v1", targetCommit: COMMIT },
    { caseId: "FF-9002", kind: "control", templateId: "made-up-control-v1", targetCommit: COMMIT },
    { caseId: "FF-9003", kind: "sabotage", templateId: "made-up-v1", targetCommit: COMMIT },
    { caseId: "FF-9004", kind: "sabotage", templateId: "made-up-v1", targetCommit: COMMIT },
    { caseId: "FF-9005", kind: "sabotage", templateId: "made-up-v1", targetCommit: "main" },
  ];
  const judged = (caseId: string) => ({ type: "case.adjudicated", caseId });
  const ticketed = (caseId: string) => ({
    type: "case.ticket-created",
    caseId,
    issue: { repo: "owner/app", number: 40, ...TICKET },
  });
  const events = [
    judged("FF-9001"),
    ticketed("FF-9001"),
    judged("FF-9002"),
    ticketed("FF-9002"),
    ticketed("FF-9003"),
    judged("FF-9004"),
    judged("FF-9005"),
    ticketed("FF-9005"),
  ];
  const everyone = new Set(truth.map((t) => t.caseId));

  it("gives a judged, published case its facts and its ordinary ticket", () => {
    expect(trialCase("FF-9001", truth, events, everyone)).toEqual({
      caseId: "FF-9001",
      control: false,
      templateId: "made-up-v1",
      targetCommit: COMMIT,
      ticket: TICKET,
    });
    expect(trialCase("FF-9002", truth, events, everyone)).toMatchObject({ control: true });
  });

  it("refuses a case without a verdict", () => {
    expect(trialCase("FF-9003", truth, events, everyone)).toEqual({
      refusal: "FF-9003 has no verdict yet: only an adjudicated case can be tried",
    });
  });

  it("refuses a case the public decision log doesn't name, such as a held-out one", () => {
    const result = trialCase("FF-9001", truth, events, new Set(["FF-9002"]));
    expect(result).toEqual({ refusal: "FF-9001 is not named by the public decision log, so it can't be tried" });
  });

  it("refuses a case that isn't in the answer key, has no ticket on record, or no commit id for its base", () => {
    expect(trialCase("FF-9999", truth, events, everyone)).toMatchObject({
      refusal: expect.stringMatching(/answer key/),
    });
    expect(trialCase("FF-9004", truth, events, everyone)).toMatchObject({
      refusal: expect.stringMatching(/no ticket/),
    });
    expect(trialCase("FF-9005", truth, events, everyone)).toMatchObject({
      refusal: expect.stringMatching(/not a commit id/),
    });
  });
});

describe("runTrial", () => {
  const facts: TrialCase = {
    caseId: "FF-9001",
    control: false,
    templateId: "made-up-v1",
    targetCommit: COMMIT,
    ticket: TICKET,
  };
  const finding = (id: string, severity: string, description = "It breaks."): TrialFinding => ({
    id,
    severity,
    title: `Finding ${id}`,
    file: "src/a.ts",
    lines: [1, 2],
    description,
  });

  /** A fake world: scripted reviews, a builder that says "fixed", and a proof that passes once the builder ran. */
  function world(
    reviews: TrialReview[],
    options: { fixWorks?: boolean; breaksOther?: boolean; changeProblems?: string[] } = {},
  ) {
    const steps: string[] = [];
    const prompts: string[] = [];
    let saved: TrialRecord | undefined;
    let built = false;
    const io: TrialIo = {
      prepare: async () => {
        steps.push("prepare");
      },
      proofs: () => [
        { invariantId: "INV-OWN", own: true },
        { invariantId: "INV-OTHER", own: false },
      ],
      runProofs: async (stage) => {
        steps.push(`proofs ${stage}`);
        if (stage === "before") return ["fail", "pass"];
        return [built && options.fixWorks !== false ? "pass" : "fail", built && options.breaksOther ? "fail" : "pass"];
      },
      review: async (round) => {
        steps.push(`review ${round}`);
        return reviews[round - 1] as TrialReview;
      },
      build: async (round, prompt, mustFix): Promise<BuilderDecision[]> => {
        steps.push(`build ${round}`);
        prompts.push(prompt);
        built = true;
        return mustFix.map((f) => ({ id: f.id, decision: "fixed" }));
      },
      evidencePasses: async () => false,
      changeProblems: () => options.changeProblems ?? [],
      publicTests: async () => "pass",
      save: (record) => {
        saved = record;
      },
      log: () => {},
    };
    return { io, steps, prompts, saved: () => saved };
  }
  const review = (open: TrialFinding[], inventoryComplete = true): TrialReview => ({
    complete: true,
    inventoryComplete,
    open,
    evidence: "saved",
  });

  it("runs the proofs before and after the loop, and saves a record that says the defect is gone", async () => {
    const w = world([review([finding("m", "remediation_recommended")]), review([])]);
    const record = await runTrial(facts, "saved", SAVED, w.io);
    expect(w.steps).toEqual(["prepare", "proofs before", "review 1", "build 1", "review 2", "proofs after"]);
    expect(record).toMatchObject({
      caseId: "FF-9001",
      kind: "bug",
      gateName: "saved",
      status: "done",
      result: "gate met, defect gone",
      damage: [],
      publicTestsAfter: "pass",
      proofs: [
        { invariantId: "INV-OWN", own: true, before: "fail", after: "pass" },
        { invariantId: "INV-OTHER", own: false, before: "pass", after: "pass" },
      ],
    });
    expect(w.saved()).toBe(record);
  });

  it("claims nothing when the builder's changes point outside the repository, whatever the proofs say", async () => {
    const w = world([review([finding("m", "remediation_recommended")]), review([])], {
      changeProblems: ["an added line holds an absolute path"],
    });
    const record = await runTrial(facts, "saved", SAVED, w.io);
    expect(record.status).toBe("done");
    expect(record.result).toBe("inconclusive");
    expect(record.changeProblems).toEqual(["an added line holds an absolute path"]);
    expect(record.note).toMatch(/point outside the repository/);
  });

  it("records whether the reviewer reported its finding inventory complete in every round", async () => {
    const partial = world([review([finding("m", "remediation_recommended")], false), review([])]);
    expect((await runTrial(facts, "saved", SAVED, partial.io)).inventoryReportedComplete).toBe(false);
    const whole = world([review([])]);
    expect((await runTrial(facts, "saved", SAVED, whole.io)).inventoryReportedComplete).toBe(true);
  });

  it("records an escape: the gate is met at once and the proof still fails", async () => {
    const w = world([review([finding("m", "remediation_recommended")])]);
    const record = await runTrial(facts, "first-label-only", gateNamed("first-label-only", SAVED), w.io);
    expect(w.steps).not.toContain("build 1");
    expect(record.status).toBe("done");
    expect(record.result).toBe("gate met, defect survived");
  });

  it("records damage when a fix breaks a proof that passed before", async () => {
    const w = world([review([finding("m", "remediation_recommended")]), review([])], { breaksOther: true });
    const record = await runTrial(facts, "saved", SAVED, w.io);
    expect(record.result).toBe("gate met, defect gone");
    expect(record.damage).toEqual(["INV-OTHER"]);
  });

  it("gives the builder the ticket and the findings, and nothing about the case", async () => {
    const w = world([review([finding("m", "remediation_recommended")]), review([])]);
    await runTrial(facts, "saved", SAVED, w.io);
    expect(w.prompts[0]).toContain("The task: Validate a request before reading the store");
    expect(w.prompts[0]).not.toMatch(/FF-9001|made-up-v1|INV-OWN/);
  });

  it("refuses before anything is made when the ticket itself would give the lab away", async () => {
    const w = world([review([])]);
    const leaky = { ...facts, ticket: { ...TICKET, body: "A planted bug for FaultForge." } };
    await expect(runTrial(leaky, "saved", SAVED, w.io)).rejects.toBeInstanceOf(LeakRefusal);
    expect(w.steps).toEqual([]);
  });

  it("never starts the builder when a finding's own text would give the lab away", async () => {
    const w = world([review([finding("m", "remediation_recommended", "This looks like a planted bug.")])]);
    await expect(runTrial(facts, "saved", SAVED, w.io)).rejects.toBeInstanceOf(LeakRefusal);
    expect(w.steps).not.toContain("build 1");
    expect(w.saved()).toBeUndefined();
  });
});

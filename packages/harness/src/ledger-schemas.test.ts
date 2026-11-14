import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answerKeyEntryProblem, answerKeyProblems, savedReviewProblem, savedReviewProblems } from "./ledger-schemas.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const PROOF = `x-secret-v1/proof.test.ts@sha256:${"c".repeat(64)}`;

const located = {
  targetRepo: "https://github.com/Owner/target.git",
  targetCommit: A,
  injectionCommit: B,
  branch: "tidy-sum",
  injectedFile: "src/sum.ts",
  injectedLines: [3, 4],
  validated: true,
  createdAt: "2026-11-14T02:00:00.000Z",
};
const BUG = {
  caseId: "FF-9501",
  kind: "sabotage",
  templateId: "x-secret-v1",
  invariantId: "INV-X-001",
  defectClass: "off-by-one",
  ...located,
  validation: {
    proofs: [{ invariantId: "INV-X-001", proofTest: PROOF, proofOnBase: "pass", proofOnVariant: "fail" }],
    typecheck: "pass",
    publicTests: "pass",
  },
};
const CONTROL = {
  caseId: "FF-9502",
  kind: "control",
  templateId: "x-control-v1",
  ...located,
  validation: {
    typecheck: "pass",
    publicTests: "pass",
    corpus: [{ invariantId: "INV-X-001", proofTest: PROOF, proofOnBase: "pass", proofOnVariant: "pass" }],
  },
};
const AMENDMENT = {
  kind: "amendment",
  amends: "FF-9501",
  at: "2026-11-14T03:00:00.000Z",
  change: { rerunOf: "FF-9500" },
  reason: "r",
  evidence: "e",
};
const FINDING = {
  id: "f1",
  file: "src/sum.ts",
  lines: [3, 3],
  severity: "action_required",
  category: "Bug",
  title: "t",
  description: "d",
};
const SAVED = {
  repo: "Owner/target",
  pr: 7,
  headSha: B,
  state: "complete",
  headMovedTo: null,
  pushSeenAt: "2026-11-14T02:00:00Z",
  reviewEffort: "standard",
  reviewSeenCompleteAt: "2026-11-14T02:05:00.000Z",
  reviewSeenCompleteNote: "n",
  reviewStartedAt: "2026-11-14T02:01:00.123456Z",
  recordedAt: "2026-11-14T02:05:01.000Z",
  ci: "npm run check: success",
  abTest: { name: null, arm: null },
  findings: [FINDING],
  openFindings: [{ ...FINDING, commit: B.slice(0, 7) }],
};

describe("the answer-key schema (AUD-N5)", () => {
  it("accepts a planted bug, a control, an amendment, and an early entry with its proof pinned on the entry", () => {
    expect(answerKeyEntryProblem(BUG)).toBeUndefined();
    expect(answerKeyEntryProblem(CONTROL)).toBeUndefined();
    expect(answerKeyEntryProblem(AMENDMENT)).toBeUndefined();
    const early = { ...BUG, proofTest: PROOF, validation: { proofOnBase: "pass", proofOnVariant: "fail" } };
    expect(answerKeyEntryProblem(early)).toBeUndefined();
  });

  it.each([
    ["an unknown field", { ...BUG, note: "x" }],
    ["a bug's field on a control", { ...CONTROL, invariantId: "INV-X-001" }],
    ["a short commit id", { ...BUG, injectionCommit: B.slice(0, 7) }],
    ["a malformed case id", { ...BUG, caseId: "FF-95" }],
    ["lines that aren't a pair", { ...BUG, injectedLines: [3] }],
    ["line zero", { ...BUG, injectedLines: [0, 1] }],
    ["an unknown outcome", { ...BUG, validation: { ...BUG.validation, typecheck: "ok" } }],
    [
      "a proof not pinned by its hash",
      { ...CONTROL, validation: { corpus: [{ ...CONTROL.validation.corpus[0], proofTest: "p.ts" }] } },
    ],
    ["no invariant on a bug", { ...BUG, invariantId: undefined }],
    ["an unknown kind", { ...BUG, kind: "planted" }],
    ["an amendment with no reason", { ...AMENDMENT, reason: "" }],
    ["an amendment of something that isn't a case", { ...AMENDMENT, amends: "evt-1" }],
  ])("refuses %s", (_name, entry) => {
    expect(answerKeyEntryProblem(JSON.parse(JSON.stringify(entry)))).toBeDefined();
  });

  it("reports each line that doesn't fit, by line, a line that isn't JSON, and passes a sound file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "schemas-")), "ground-truth.jsonl");
    writeFileSync(path, `${[BUG, CONTROL, AMENDMENT].map((l) => JSON.stringify(l)).join("\n")}\n`);
    expect(answerKeyProblems(path)).toEqual([]);
    writeFileSync(path, `${JSON.stringify(BUG)}\n${JSON.stringify({ ...CONTROL, extra: 1 })}\n`);
    expect(answerKeyProblems(path)).toEqual([expect.stringMatching(/^ground-truth\.jsonl line 2: /)]);
    writeFileSync(path, `${JSON.stringify(BUG)}\nnot json\n`);
    expect(answerKeyProblems(path)).toEqual([expect.stringMatching(/^ground-truth\.jsonl line 2 is not JSON/)]);
  });
});

describe("the saved-review schema (AUD-N5)", () => {
  it("accepts what review:wait writes, a review that never finished, and an early save without the later fields", () => {
    expect(savedReviewProblem(SAVED)).toBeUndefined();
    const unfinished = { ...SAVED, state: "review incomplete", reviewSeenCompleteAt: null, reviewEffort: null };
    expect(savedReviewProblem(unfinished)).toBeUndefined();
    const { reviewSeenCompleteAt: _a, reviewSeenCompleteNote: _b, openFindings: _c, headMovedTo: _d, ...early } = SAVED;
    expect(savedReviewProblem(early)).toBeUndefined();
    expect(savedReviewProblem({ ...SAVED, findings: [{ ...FINDING, file: null, lines: null }] })).toBeUndefined();
  });

  it.each([
    ["an unknown state", { ...SAVED, state: "done" }],
    ["no findings list", { ...SAVED, findings: undefined }],
    ["findings that aren't a list", { ...SAVED, findings: {} }],
    ["a finding with one line", { ...SAVED, findings: [{ ...FINDING, lines: [3] }] }],
    ["a finding with no id", { ...SAVED, findings: [{ ...FINDING, id: undefined }] }],
    ["a short head commit", { ...SAVED, headSha: B.slice(0, 7) }],
    ["an unknown field", { ...SAVED, verdict: "caught" }],
    ["an open finding without its commit", { ...SAVED, openFindings: [FINDING] }],
    ["a PR that isn't a number", { ...SAVED, pr: "7" }],
  ])("refuses %s", (_name, review) => {
    expect(savedReviewProblem(JSON.parse(JSON.stringify(review)))).toBeDefined();
  });

  it("reports each save under the reviews folder that isn't JSON or doesn't fit", () => {
    const reviews = mkdtempSync(join(tmpdir(), "schemas-reviews-"));
    mkdirSync(join(reviews, "target-pr7"));
    writeFileSync(join(reviews, "target-pr7", "bbbbbbb.review.json"), JSON.stringify(SAVED));
    writeFileSync(join(reviews, "target-pr7", "bbbbbbb.qodo-api.raw.json"), "{}");
    expect(savedReviewProblems(reviews)).toEqual([]);
    writeFileSync(join(reviews, "target-pr7", "ccccccc.review.json"), "{");
    writeFileSync(join(reviews, "target-pr7", "ddddddd.review.json"), JSON.stringify({ ...SAVED, state: "done" }));
    expect(savedReviewProblems(reviews)).toEqual([
      "reviews/target-pr7/ccccccc.review.json: not JSON",
      expect.stringMatching(/^reviews\/target-pr7\/ddddddd\.review\.json: \/state /),
    ]);
  });
});

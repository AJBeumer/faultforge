import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLedger } from "./ledger.ts";
import {
  hashProblems,
  injectionInputHash,
  ownProofFiles,
  recomputeInjectionHash,
  verdictInputHash,
} from "./ledger-hashes.ts";

const COMMIT = "d".repeat(40);
const BASE = "a".repeat(40);

/** Private storage with one bug case planted and judged by the tools, every hash as they wrote it. */
function fixture(verdictTool = "faultforge-harness@1.0.0") {
  const root = mkdtempSync(join(tmpdir(), "ledger-hashes-"));
  const dir = join(root, "templates", "x-secret-v1");
  mkdirSync(dir, { recursive: true });
  const template = { kind: "bug", proofTest: "proof.test.ts", alsoBreaks: [{ proofTest: "more.proof.test.ts" }] };
  const templateText = JSON.stringify(template);
  writeFileSync(join(dir, "template.json"), templateText);
  writeFileSync(join(dir, "proof.test.ts"), "// one\n");
  writeFileSync(join(dir, "more.proof.test.ts"), "// two\n");
  const groundTruthPath = join(root, "ground-truth.jsonl");
  const entry = { caseId: "FF-9200", kind: "sabotage", templateId: "x-secret-v1", targetCommit: BASE };
  writeFileSync(groundTruthPath, `${JSON.stringify({ ...entry, injectionCommit: COMMIT })}\n`);
  const reviewDir = join(root, "raw-artifacts", "reviews", "target-pr4");
  mkdirSync(reviewDir, { recursive: true });
  const savePath = join(reviewDir, `${COMMIT.slice(0, 7)}.review.json`);
  const saveText = JSON.stringify({ pr: 4, headSha: COMMIT, state: "complete", findings: [] });
  writeFileSync(savePath, saveText);
  const at = "2026-11-03T00:00:00.000Z";
  const judged = readLedger(groundTruthPath)[0];
  const events = [
    {
      eventId: "inj",
      type: "sabotage.injected",
      caseId: "FF-9200",
      at: "2026-11-01T00:00:00.000Z",
      tool: "faultforge-harness@1.0.0",
      inputHash: injectionInputHash(templateText, ["// one\n", "// two\n"], BASE),
    },
    { eventId: "pr", type: "pr.opened", caseId: "FF-9200", at: "2026-11-02T00:00:00.000Z", pr: 4 },
    {
      eventId: "ver",
      type: "case.adjudicated",
      caseId: "FF-9200",
      at,
      tool: verdictTool,
      inputHash: verdictInputHash(judged as never, templateText, saveText),
    },
  ];
  const auditEventsPath = join(root, "audit-events.jsonl");
  writeFileSync(auditEventsPath, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  const paths = { groundTruthPath, auditEventsPath, reviewsDir: join(root, "raw-artifacts", "reviews") };
  return { root, dir, paths, savePath, env: { FAULTFORGE_PRIVATE_DIR: root } };
}

describe("hashProblems (AUD-M26, #249)", () => {
  it("finds nothing while every input is as the tools hashed it", () => {
    const fx = fixture();
    expect(hashProblems(fx.paths, fx.env)).toEqual([]);
  });

  it("reports a template changed after injection, for both the injection and the verdict", () => {
    const fx = fixture();
    const path = join(fx.dir, "template.json");
    writeFileSync(path, readFileSync(path, "utf8").replace("bug", "bug "));
    expect(hashProblems(fx.paths, fx.env)).toEqual([
      "FF-9200 sabotage.injected event inj: its inputHash no longer recomputes: the template or a proof changed after it was recorded",
      "FF-9200 case.adjudicated event ver: its inputHash no longer recomputes: the answer-key entry, the template or the saved review changed after it was recorded",
    ]);
  });

  it("reports a proof changed after injection", () => {
    const fx = fixture();
    writeFileSync(join(fx.dir, "more.proof.test.ts"), "// changed\n");
    expect(hashProblems(fx.paths, fx.env)).toEqual([expect.stringContaining("sabotage.injected event inj")]);
  });

  it("reports a saved review changed after the verdict", () => {
    const fx = fixture();
    writeFileSync(fx.savePath, `${readFileSync(fx.savePath, "utf8")} `);
    expect(hashProblems(fx.paths, fx.env)).toEqual([expect.stringContaining("case.adjudicated event ver")]);
  });

  it("still recomputes after a later answer-key amendment: the verdict hashed the entry as it was then", () => {
    const fx = fixture();
    const amendment = { kind: "amendment", amends: "FF-9200", at: "2026-11-04T00:00:00.000Z", change: { x: 1 } };
    appendFileSync(fx.paths.groundTruthPath, `${JSON.stringify({ ...amendment, reason: "r", evidence: "e" })}\n`);
    expect(hashProblems(fx.paths, fx.env)).toEqual([]);
  });

  it("skips a hand-written verdict, which no tool hashed", () => {
    const fx = fixture("manual-session");
    writeFileSync(fx.savePath, "{}");
    expect(hashProblems(fx.paths, fx.env)).toEqual([]);
  });

  it("accepts a recorded drift only at its pinned hash, so any further change is still reported", () => {
    const fx = fixture();
    const path = join(fx.dir, "template.json");
    writeFileSync(path, readFileSync(path, "utf8").replace("bug", "bug "));
    const now = recomputeInjectionHash(readLedger(fx.paths.groundTruthPath)[0] as never, fx.env) as string;
    const drift = new Map([["inj", { hash: now }]]);
    const problems = hashProblems(fx.paths, fx.env, drift);
    expect(problems.some((p) => p.includes("event inj"))).toBe(false);
    writeFileSync(path, readFileSync(path, "utf8").replace("bug ", "bug  "));
    expect(hashProblems(fx.paths, fx.env, drift).some((p) => p.includes("event inj"))).toBe(true);
  });
});

describe("ownProofFiles", () => {
  it("lists a bug template's proof, then its collateral proofs; a control has none", () => {
    expect(ownProofFiles({ kind: "bug", proofTest: "a.ts", alsoBreaks: [{ proofTest: "b.ts" }] })).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(ownProofFiles({ kind: "control" })).toEqual([]);
  });
});

describe("hashProblems: what Qodo found on PR 264", () => {
  it("checks a verdict against the file it names, even when that isn't the PR's save (--review)", () => {
    const fx = fixture();
    const other = join(fx.root, "elsewhere.review.json");
    writeFileSync(other, '{"pr":4,"state":"complete","findings":[]}');
    const lines = readFileSync(fx.paths.auditEventsPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const verdict = lines.find((e) => e.eventId === "ver");
    verdict.reviewFile = "elsewhere.review.json";
    verdict.inputHash = verdictInputHash(
      readLedger(fx.paths.groundTruthPath)[0] as never,
      readFileSync(join(fx.dir, "template.json"), "utf8"),
      readFileSync(other, "utf8"),
    );
    writeFileSync(fx.paths.auditEventsPath, lines.map((e) => `${JSON.stringify(e)}\n`).join(""));
    expect(hashProblems(fx.paths, fx.env)).toEqual([]);
    writeFileSync(other, "{}");
    expect(hashProblems(fx.paths, fx.env)).toEqual([expect.stringContaining("event ver")]);
  });

  it("accepts an amendment already in the file when the verdict read it, whatever time it claims", () => {
    const fx = fixture();
    // Appended before the verdict, but dated after it: the verdict hashed the entry with it applied.
    const amendment = { kind: "amendment", amends: "FF-9200", at: "2027-01-01T00:00:00.000Z", change: { x: 1 } };
    appendFileSync(fx.paths.groundTruthPath, `${JSON.stringify({ ...amendment, reason: "r", evidence: "e" })}\n`);
    const lines = readFileSync(fx.paths.auditEventsPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const verdict = lines.find((e) => e.eventId === "ver");
    verdict.inputHash = verdictInputHash(
      readLedger(fx.paths.groundTruthPath)[0] as never,
      readFileSync(join(fx.dir, "template.json"), "utf8"),
      readFileSync(fx.savePath, "utf8"),
    );
    writeFileSync(fx.paths.auditEventsPath, lines.map((e) => `${JSON.stringify(e)}\n`).join(""));
    expect(hashProblems(fx.paths, fx.env)).toEqual([]);
  });

  it("reports a template that no longer parses, and goes on to the other events", () => {
    const fx = fixture();
    writeFileSync(join(fx.dir, "template.json"), "{ not json");
    const problems = hashProblems(fx.paths, fx.env);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("can't be recomputed");
  });
});

describe("verdictHashProblem: a template named by a later amendment (Qodo on PR 264)", () => {
  it("still holds with the template the verdict read", () => {
    const fx = fixture();
    const other = join(fx.root, "templates", "x-other-v1");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "template.json"), '{"kind":"control"}');
    const amendment = {
      kind: "amendment",
      amends: "FF-9200",
      at: "2026-11-05T00:00:00.000Z",
      change: { templateId: "x-other-v1" },
    };
    appendFileSync(fx.paths.groundTruthPath, `${JSON.stringify({ ...amendment, reason: "r", evidence: "e" })}\n`);
    expect(hashProblems(fx.paths, fx.env).filter((p) => p.includes("event ver"))).toEqual([]);
  });
});

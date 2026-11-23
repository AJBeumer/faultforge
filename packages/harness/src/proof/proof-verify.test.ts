import { describe, expect, it } from "vitest";
import { classifyRun, decide, type ProofFacts, testPathProblem } from "./proof-verify.ts";

const assertion = { status: "failed", failureMessages: ["AssertionError: expected 1 to be 2"] };
const passed = { status: "passed", failureMessages: [] };

describe("classifyRun", () => {
  it("reads an assertion failure, a pass, a crash, a load error and a missing report", () => {
    expect(classifyRun({ testResults: [{ assertionResults: [assertion, passed] }] })).toBe("assertion-red");
    expect(classifyRun({ testResults: [{ assertionResults: [passed] }] })).toBe("green");
    const crash = { status: "failed", failureMessages: ["TypeError: x is not a function"] };
    expect(classifyRun({ testResults: [{ assertionResults: [assertion, crash] }] })).toBe("error");
    const timeout = { status: "failed", failureMessages: ["Error: Test timed out in 5000ms."] };
    expect(classifyRun({ testResults: [{ assertionResults: [timeout] }] })).toBe("error");
    expect(classifyRun({ testResults: [{ status: "failed", message: "SyntaxError", assertionResults: [] }] })).toBe(
      "error",
    );
    expect(classifyRun({ testResults: [] })).toBe("no-tests");
    expect(classifyRun(null)).toBe("error");
  });
});

describe("testPathProblem", () => {
  const existing = new Set(["src/a.ts", "src/a.test.ts"]);
  it("takes a new relative .test.ts path and refuses the rest", () => {
    expect(testPathProblem("src/a.proof.test.ts", existing)).toBeNull();
    expect(testPathProblem("src/a.test.ts", existing)).toMatch(/existing file/);
    expect(testPathProblem("../x.test.ts", existing)).toMatch(/relative/);
    expect(testPathProblem("C:/x.test.ts", existing)).toMatch(/relative/);
    expect(testPathProblem("src/a.ts", existing)).toMatch(/\.test\.ts/);
    expect(testPathProblem("node_modules/x/a.test.ts", existing)).toMatch(/node_modules/);
  });
});

const good: ProofFacts = {
  cited: { file: "src/a.ts", start: 10, end: 10 },
  testPath: "src/a.proof.test.ts",
  testText: 'import { f } from "./a.ts";\nexpect(f()).toBe(1);',
  patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,1 +10,1 @@\n-return 2;\n+return 1;\n",
  existing: new Set(["src/a.ts"]),
  reviewed: "assertion-red",
  patched: "green",
  changedFiles: [],
};

describe("decide", () => {
  it("certifies a bundle that meets all four conditions", () => {
    expect(decide(good)).toEqual({ certified: true, reasons: [] });
  });

  it("1: refuses a test that is green, crashes or finds no test on the reviewed commit", () => {
    for (const reviewed of ["green", "error", "no-tests"] as const) {
      expect(decide({ ...good, reviewed }).reasons.join()).toMatch(/not as an assertion failure/);
    }
  });

  it("2: refuses a test that is still red with the patch applied", () => {
    expect(decide({ ...good, patched: "assertion-red" }).reasons.join()).toMatch(/not green/);
  });

  it("3: refuses a patch that reaches outside the cited lines", () => {
    const wide = { ...good, patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -11,1 +11,1 @@\n-x\n+y\n" };
    expect(decide(wide).reasons.join()).toMatch(/removes line 11/);
  });

  it("4: refuses a test that replaces an existing file, changes one, or reaches outside the repository", () => {
    expect(decide({ ...good, testPath: "src/a.ts" }).certified).toBe(false);
    expect(decide({ ...good, changedFiles: ["src/b.ts"] }).reasons.join()).toMatch(/existing files changed/);
    expect(decide({ ...good, testText: 'readFileSync("C:/secret")' }).reasons.join()).toMatch(/absolute path/);
  });

  it("refuses a bundle whose test was never run", () => {
    expect(decide({ ...good, reviewed: undefined }).reasons).toEqual(["the test was not run"]);
  });
});

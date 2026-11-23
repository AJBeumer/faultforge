import { describe, expect, it } from "vitest";
import {
  agreedClass,
  classifyRun,
  climbProblem,
  decide,
  type ProofFacts,
  sandboxArgs,
  testPathProblem,
} from "./proof-verify.ts";

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

describe("climbProblem", () => {
  const at = "packages/harness/src/guard/install.proof.test.ts"; // four folders deep
  it("lets a relative path climb within the repository", () => {
    expect(climbProblem(at, 'import { x } from "../../shared/paths.ts";')).toBeNull();
    expect(climbProblem(at, 'import "../../../../vitest.config.ts";')).toBeNull();
  });
  it("refuses one that climbs above it, with either slash", () => {
    expect(climbProblem(at, 'readFileSync("../../../../../secret")')).toMatch(/above the repository/);
    expect(climbProblem("a.proof.test.ts", 'import "..\\\\x.ts";')).toMatch(/above the repository/);
  });
  it("adds up separate climbs, as the path resolves", () => {
    expect(climbProblem("src/a/t.proof.test.ts", 'readFileSync("../../x/../../secret")')).toMatch(/\.\.\/secret/);
    expect(climbProblem("src/a/t.proof.test.ts", 'import "../b/../c.ts";')).toBeNull();
  });
});

describe("agreedClass", () => {
  it("keeps a class only when the exit code agrees", () => {
    expect(agreedClass("green", 0)).toBe("green");
    expect(agreedClass("green", 1)).toBe("error");
    expect(agreedClass("assertion-red", 1)).toBe("assertion-red");
    expect(agreedClass("assertion-red", null)).toBe("error");
    expect(agreedClass("error", 0)).toBe("error");
  });
});

describe("sandboxArgs", () => {
  it("reads only the export and parent marker files, and writes only temp, caches and the report", () => {
    const args = sandboxArgs("C:\\T\\proof-1", "C:\\T\\proof-1\\.tmp", "D:\\out\\r.json", "src/a.proof.test.ts");
    expect(args.slice(0, 3)).toEqual(["--permission", "--allow-addons", "--allow-worker"]);
    expect(args.filter((a) => a.startsWith("--allow-fs-read="))).toEqual([
      "--allow-fs-read=C:\\T\\proof-1",
      "--allow-fs-read=C:\\T\\pnpm-workspace.yaml",
      "--allow-fs-read=C:\\T\\lerna.json",
      "--allow-fs-read=C:\\T\\package.json",
      "--allow-fs-read=C:\\pnpm-workspace.yaml",
      "--allow-fs-read=C:\\lerna.json",
      "--allow-fs-read=C:\\package.json",
    ]);
    expect(args.filter((a) => a.startsWith("--allow-fs-write="))).toEqual([
      "--allow-fs-write=C:\\T\\proof-1\\.tmp",
      "--allow-fs-write=C:\\T\\proof-1\\node_modules\\.vitest\\*",
      "--allow-fs-write=C:\\T\\proof-1\\node_modules\\.vitest-cache\\*",
      "--allow-fs-write=C:\\T\\proof-1\\node_modules\\.vite\\*",
      "--allow-fs-write=D:\\out\\r.json",
    ]);
    const vitest = args.findIndex((a) => a.endsWith("vitest.mjs"));
    expect(args.slice(0, vitest)).toContain("--allow-child-process"); // Vitest's main process starts the test's
    expect(args).toContain("--pool=forks");
    const child = args.filter((a) => a.startsWith("--execArgv=")).map((a) => a.slice("--execArgv=".length));
    expect(child).toContain("--permission");
    expect(child).toContain("--allow-fs-read=C:\\T\\proof-1");
    expect(child).not.toContain("--allow-child-process"); // the test can't start a process
  });
  it("walks a POSIX path to the root", () => {
    const reads = sandboxArgs("/tmp/proof-1", "/tmp/proof-1/.tmp", "/o/r.json", "a.test.ts").filter((a) =>
      a.startsWith("--allow-fs-read="),
    );
    expect(reads).toContain("--allow-fs-read=/tmp/package.json");
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

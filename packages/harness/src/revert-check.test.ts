import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseNameStatus,
  parseVitestReport,
  revertCheck,
  runnableTests,
  splitFiles,
  strippedEnv,
  type TestRun,
  verdict,
} from "./revert-check.ts";

const TESTS = /(\.test\.ts$|\/fixtures\/)/;

describe("splitting a PR's files", () => {
  const changes = parseNameStatus(
    "M\tsrc/bookings/list.ts\nA\ttest/bookings.test.ts\nA\tpackages/harness/fixtures/review.json\nD\tsrc/old.test.ts\nM\tREADME.md\n",
  );

  it("reads git's name-status output", () => {
    expect(changes[0]).toEqual({ status: "M", path: "src/bookings/list.ts" });
    expect(changes).toHaveLength(5);
  });

  it("keeps test files and fixtures as tests, everything else as code", () => {
    const { tests, code } = splitFiles(changes, TESTS);
    expect(tests.map((c) => c.path)).toEqual([
      "test/bookings.test.ts",
      "packages/harness/fixtures/review.json",
      "src/old.test.ts",
    ]);
    expect(code.map((c) => c.path)).toEqual(["src/bookings/list.ts", "README.md"]);
  });

  it("runs only test files present at the head, not fixtures or deleted tests", () => {
    expect(runnableTests(splitFiles(changes, TESTS).tests)).toEqual(["test/bookings.test.ts"]);
  });
});

describe("reading vitest's JSON report", () => {
  it("lists failed tests, and a file that failed before any test ran", () => {
    const result = parseVitestReport({
      testResults: [
        {
          name: "/x/a.test.ts",
          status: "failed",
          assertionResults: [
            { fullName: "list filters by status", status: "failed" },
            { fullName: "list returns all", status: "passed" },
          ],
        },
        { name: "/x/b.test.ts", status: "failed", message: "TypeError: listBookings is not a function\n  at ..." },
      ],
    });
    expect(result).toEqual({
      failed: ["list filters by status", "/x/b.test.ts: TypeError: listBookings is not a function"],
      passed: 1,
    });
  });
});

describe("the verdict", () => {
  const files = { tests: ["test/a.test.ts"], code: [{ status: "M", path: "src/a.ts" }] };
  const run = (failed: string[]): TestRun => ({ ran: true, failed, passed: 3 });

  it("is caught (0) when a test fails without the change", () => {
    expect(verdict(files, run([]), run(["filters by status"]))).toMatchObject({
      exit: 0,
      failedWithoutChange: ["filters by status"],
    });
  });

  it("is not proven (1), naming the test files, when every test still passes", () => {
    const outcome = verdict(files, run([]), run([]));
    expect(outcome.exit).toBe(1);
    expect(outcome.message).toMatch(/test\/a\.test\.ts/);
  });

  it("can't judge (2) a PR with no test file, or no code file", () => {
    expect(verdict({ tests: [], code: files.code }).message).toMatch(/no test file/);
    expect(verdict({ tests: files.tests, code: [] }).message).toMatch(/no code file/);
  });

  it("can't judge (2) tests that fail even with the change: they prove nothing", () => {
    expect(verdict(files, run(["broken"]), run(["broken"]))).toMatchObject({ exit: 2 });
  });

  it("can't judge (2) when the copy couldn't run its tests", () => {
    expect(verdict(files, { ran: false, failed: [], passed: 0, error: "no vitest" })).toMatchObject({ exit: 2 });
  });
});

describe("the tests' environment", () => {
  it("keeps what a runner needs and drops every key and token", () => {
    const env = strippedEnv({
      PATH: "/bin",
      TEMP: "/tmp",
      GH_TOKEN: "x",
      QODO_API_KEY: "y",
      CLAUDE_CODE_OAUTH_TOKEN: "z",
      FACTORY_GH_TOKEN: "w",
    });
    expect(env).toEqual({ PATH: "/bin", TEMP: "/tmp", CI: "1", NODE_ENV: "test" });
  });
});

describe("revertCheck on a real git repository", () => {
  let root: string;
  const sh = (repo: string, ...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  /** A repo whose base has `filter` returning everything, and a PR that makes it filter, with a test. */
  function repoWithPr(testText: string) {
    root = mkdtempSync(join(tmpdir(), "revert-check-test-"));
    const repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "config", "user.email", "t@example.com");
    sh(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "src", "list.ts"), "export const filter = 'all';\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "base");
    const base = sh(repo, "rev-parse", "HEAD");
    sh(repo, "checkout", "-qb", "feature");
    writeFileSync(join(repo, "src", "list.ts"), "export const filter = 'status';\n");
    writeFileSync(join(repo, "src", "added.ts"), "export const added = true;\n");
    writeFileSync(join(repo, "src", "list.test.ts"), testText);
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "filter by status");
    const head = sh(repo, "rev-parse", "HEAD");
    sh(repo, "checkout", "-q", "main");
    // Stands in for installed packages: must survive the check untouched.
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(repo, "uncommitted.txt"), "work in progress\n");
    return { repo, base, head };
  }

  /** A fake runner: the test "passes" only when the copy holds the PR's version of list.ts. */
  const seen: { dir: string; list: string; crlf: boolean; added: boolean; modules: boolean }[] = [];
  const runTests = (dir: string): TestRun => {
    const raw = readFileSync(join(dir, "src", "list.ts"), "utf8");
    const list = raw.replace(/\r\n/g, "\n");
    seen.push({
      dir,
      list,
      crlf: raw.includes("\r\n"),
      added: existsSync(join(dir, "src", "added.ts")),
      modules: existsSync(join(dir, "node_modules", "pkg", "index.js")),
    });
    const ok = list.includes("'status'");
    return { ran: true, failed: ok ? [] : ["filters by status"], passed: ok ? 1 : 0 };
  };

  afterEach(() => {
    seen.length = 0;
    rmSync(root, { recursive: true, force: true });
  });

  it("runs the PR's tests with the change, then without it, and reports the failure", () => {
    const { repo, base, head } = repoWithPr("test\n");
    const outcome = revertCheck({ repo, base, head, tests: TESTS, runTests, temp: root });
    expect(outcome).toMatchObject({ exit: 0, failedWithoutChange: ["filters by status"] });
    expect(seen[0]).toMatchObject({ list: "export const filter = 'status';\n", added: true, modules: true });
    // Without the change: the modified file is back at base, the added one is gone.
    expect(seen[1]).toMatchObject({ list: "export const filter = 'all';\n", added: false });
  });

  it("checks the base version out the same way as the head, line endings included", () => {
    // First run on Windows: the head came out with CRLF and the restored base with LF, a difference
    // that isn't the PR's change. Both now go through git's checkout.
    const { repo, base, head } = repoWithPr("test\n");
    sh(repo, "config", "core.autocrlf", "true");
    revertCheck({ repo, base, head, tests: TESTS, runTests, temp: root });
    expect(seen.map((s) => s.crlf)).toEqual([seen[0]?.crlf, seen[0]?.crlf]);
  });

  it("changes nothing in the repository: working tree, index, branches, and node_modules", () => {
    const { repo, base, head } = repoWithPr("test\n");
    const before = {
      status: sh(repo, "status", "--porcelain"),
      refs: sh(repo, "for-each-ref"),
      index: readFileSync(join(repo, ".git", "index")).toString("base64"),
      head: sh(repo, "rev-parse", "HEAD"),
      list: readFileSync(join(repo, "src", "list.ts"), "utf8"),
    };
    revertCheck({ repo, base, head, tests: TESTS, runTests, temp: root });
    expect({
      status: sh(repo, "status", "--porcelain"),
      refs: sh(repo, "for-each-ref"),
      index: readFileSync(join(repo, ".git", "index")).toString("base64"),
      head: sh(repo, "rev-parse", "HEAD"),
      list: readFileSync(join(repo, "src", "list.ts"), "utf8"),
    }).toEqual(before);
    expect(readFileSync(join(repo, "node_modules", "pkg", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(sh(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("removes its scratch copy afterwards", () => {
    const { repo, base, head } = repoWithPr("test\n");
    revertCheck({ repo, base, head, tests: TESTS, runTests, temp: root });
    expect(readdirSync(root).filter((name) => name.startsWith("revert-check-"))).toEqual([]);
  });

  it("is not proven when the tests pass either way", () => {
    const { repo, base, head } = repoWithPr("test\n");
    const outcome = revertCheck({
      repo,
      base,
      head,
      tests: TESTS,
      runTests: () => ({ ran: true, failed: [], passed: 1 }),
      temp: root,
    });
    expect(outcome.exit).toBe(1);
  });

  it("can't judge a PR without a test file, and never builds a copy for it", () => {
    const { repo, base, head } = repoWithPr("test\n");
    const outcome = revertCheck({ repo, base, head, tests: /^nothing-matches$/, runTests, temp: root });
    expect(outcome.exit).toBe(2);
    expect(seen).toEqual([]);
  });
});

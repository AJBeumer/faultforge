import { describe, expect, it } from "vitest";
import { outcomeOf, parseVitestReport, proofOutcomeOf, stepLogText } from "./run-outcome.ts";

describe("outcomeOf", () => {
  it("passes on a clean exit", () => {
    expect(outcomeOf({ status: 0 })).toBe("pass");
  });

  it("fails on a nonzero exit: the run finished and found the problem", () => {
    expect(outcomeOf({ status: 1 })).toBe("fail");
  });

  it("is not_run, never fail, when the process never finished (a time limit kills it, status null)", () => {
    expect(outcomeOf({ status: null })).toBe("not_run");
  });

  it("is not_run, never fail, when the process could not even be spawned", () => {
    expect(outcomeOf({ status: null, error: new Error("spawn ENOENT") })).toBe("not_run");
  });

  it("treats a spawn error as not_run even if a stray nonzero status is also present", () => {
    expect(outcomeOf({ status: 1, error: new Error("boom") })).toBe("not_run");
  });
});

describe("stepLogText", () => {
  const base = { stdout: "out\n", stderr: "" };

  it("names the outcome for a clean pass, with no detail parenthetical", () => {
    const text = stepLogText(["vitest", "run"], { ...base, status: 0 }, "pass");
    expect(text).toContain("exit 0\noutcome pass\n");
    expect(text).not.toContain("(");
  });

  it("names not_run and the signal when a process is killed without a spawn error (#114)", () => {
    const text = stepLogText(["vitest", "run"], { ...base, status: null, signal: "SIGTERM" }, "not_run");
    expect(text).toContain("exit null\noutcome not_run (signal SIGTERM)\n");
  });

  it("names not_run and the spawn error when the process could never start", () => {
    const text = stepLogText(
      ["does-not-exist"],
      { ...base, status: null, error: new Error("spawn ENOENT") },
      "not_run",
    );
    expect(text).toContain("outcome not_run (spawn ENOENT)\n");
  });

  it("names both the signal and the error for a run killed by its own time limit", () => {
    const text = stepLogText(
      ["vitest", "run"],
      { ...base, status: null, signal: "SIGTERM", error: new Error("spawnSync vitest ETIMEDOUT") },
      "not_run",
    );
    expect(text).toContain("outcome not_run (signal SIGTERM: spawnSync vitest ETIMEDOUT)\n");
  });

  it("never prints a bare exit null with no outcome", () => {
    const text = stepLogText(["vitest", "run"], { ...base, status: null, signal: "SIGTERM" }, "not_run");
    expect(text).not.toMatch(/exit null\n\n/);
  });
});

describe("reading vitest's JSON report", () => {
  it("lists failed tests, and keeps a file that failed before any test ran apart (#217)", () => {
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
      failed: ["list filters by status"],
      loadFailed: ["/x/b.test.ts: TypeError: listBookings is not a function"],
      passed: 1,
    });
  });
});

describe("a proof's outcome (#217)", () => {
  const ran = (status: "passed" | "failed") => ({
    testResults: [{ name: "/p.test.ts", status, assertionResults: [{ fullName: "invariant holds", status }] }],
  });
  const loadError = { testResults: [{ name: "/p.test.ts", status: "failed", message: "Error: Cannot find module" }] };

  it("fails only when a test ran and failed", () => {
    expect(proofOutcomeOf({ status: 1 }, ran("failed"))).toBe("fail");
  });

  it("passes when every test ran and passed and the run exited 0", () => {
    expect(proofOutcomeOf({ status: 0 }, ran("passed"))).toBe("pass");
  });

  it("is not_run, never fail, for a proof that failed to load", () => {
    expect(proofOutcomeOf({ status: 1 }, loadError)).toBe("not_run");
  });

  it("is not_run for no tests, no report, a non-zero exit with no failed test, or a run that never finished", () => {
    expect(proofOutcomeOf({ status: 1 }, { testResults: [] })).toBe("not_run");
    expect(proofOutcomeOf({ status: 1 })).toBe("not_run");
    expect(proofOutcomeOf({ status: 1 }, ran("passed"))).toBe("not_run");
    expect(proofOutcomeOf({ status: null }, ran("failed"))).toBe("not_run");
  });
});

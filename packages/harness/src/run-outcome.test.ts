import { describe, expect, it } from "vitest";
import { outcomeOf, stepLogText } from "./run-outcome.ts";

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

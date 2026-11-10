import { describe, expect, it } from "vitest";
import { outcomeOf } from "./run-outcome.ts";

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

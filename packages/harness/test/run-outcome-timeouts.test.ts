import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { outcomeOf } from "../src/run-outcome.ts";

describe("outcomeOf: a real process that doesn't finish (#114)", () => {
  it("is not_run, never fail, when a real time limit kills the process", () => {
    const result = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      encoding: "utf8",
      timeout: 150,
    });
    expect(result.status).toBeNull();
    expect(outcomeOf(result)).toBe("not_run");
  });

  it("is not_run, never fail, when the binary can't be spawned at all", () => {
    const result = spawnSync("ff-114-binary-that-does-not-exist", [], { encoding: "utf8", timeout: 1000 });
    expect(result.error).toBeDefined();
    expect(outcomeOf(result)).toBe("not_run");
  });
});

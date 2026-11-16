import { describe, expect, it } from "vitest";
import { runExternal } from "../src/shared/github.ts";

describe("runExternal against a real process that hangs", () => {
  it("actually enforces its time limit, naming the call", () => {
    const start = Date.now();
    expect(() => runExternal("a slow helper", process.execPath, ["-e", "setTimeout(() => {}, 5000)"], 150)).toThrow(
      /a slow helper timed out/,
    );
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

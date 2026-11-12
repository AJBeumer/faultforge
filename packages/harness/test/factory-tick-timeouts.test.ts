import { describe, expect, it } from "vitest";
import { runExternal } from "../src/github.ts";

describe("runExternal: a real hanging process (#107)", () => {
  it("actually enforces its time limit, naming the call", () => {
    const start = Date.now();
    expect(() => runExternal("a slow helper", process.execPath, ["-e", "setTimeout(() => {}, 5000)"], 150)).toThrow(
      /a slow helper timed out/,
    );
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

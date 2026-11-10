import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/case-build.ts";

const root = join(import.meta.dirname, "../../..");

/** FF-0001's review predates `review:wait` (#11's notes); this is the one real case to regenerate. */
describe("case:build against the real FF-0001 evidence (#11)", () => {
  it("regenerates examples/FF-0001.json byte for byte", async () => {
    const lines: string[] = [];
    const code = await run("FF-0001", { log: (line) => lines.push(line), error: (line) => lines.push(line) });
    expect(code).toBe(0);
    const printed = lines.filter((l) => !l.startsWith("[case:build]")).join("\n");
    const expected = readFileSync(join(root, "examples/FF-0001.json"), "utf8").trimEnd();
    expect(printed).toBe(expected);
  });
});

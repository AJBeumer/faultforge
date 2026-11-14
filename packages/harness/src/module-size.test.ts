import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `CLAUDE.md`'s module size rule: no module over 400 lines; one that grows past it is split along its seams
 * into named modules. The last exception, `factory-tick.ts`, was split (#109, AUD-N2), so there is none.
 */
const ROOT = join(import.meta.dirname, "../../..");
const LIMIT = 400;

function sourceModules(): string[] {
  return execFileSync("git", ["-C", ROOT, "ls-files", "packages/*.ts", ".claude/hooks/*.ts"], { encoding: "utf8" })
    .split("\n")
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.includes("/test/"));
}

function lineCount(path: string): number {
  return readFileSync(join(ROOT, path), "utf8").split("\n").length - 1;
}

describe("the module size rule (#199, #109)", () => {
  it("finds the modules it checks", () => {
    expect(sourceModules()).toContain("packages/harness/src/factory-tick.ts");
  });

  it("lets no module pass the limit, with no exception", () => {
    const over = sourceModules()
      .filter((path) => lineCount(path) > LIMIT)
      .map((path) => `${path} (${lineCount(path)} lines)`);
    expect(over).toEqual([]);
  });
});

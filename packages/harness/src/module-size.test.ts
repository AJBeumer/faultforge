import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `CLAUDE.md`'s module size rule names every module allowed over the limit. This keeps the rule and the
 * code in step (#199): a module that passes the limit must be split or named there, and a name that no
 * longer needs to be there must be taken off.
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

function namedInRule(): string[] {
  const rule = readFileSync(join(ROOT, "CLAUDE.md"), "utf8")
    .split("\n")
    .find((line) => line.includes(`A module over ${LIMIT} lines`));
  return [...(rule ?? "").matchAll(/`([\w-]+\.ts)`/g)]
    .map((m) => m[1] ?? "")
    .filter((name) => name !== "module-size.test.ts");
}

describe("CLAUDE.md's module size rule", () => {
  it("is found, with its list of modules over the limit", () => {
    expect(namedInRule().length).toBeGreaterThan(0);
  });

  it("names every module over the limit", () => {
    const over = sourceModules()
      .filter((path) => lineCount(path) > LIMIT)
      .map((path) => basename(path));
    expect(over.filter((name) => !namedInRule().includes(name))).toEqual([]);
  });

  it("lets no named module grow more than a fix's worth past its size when the rule was written", () => {
    // Sizes on 13 November 2026 (#199). A named module may take a fix, not a feature: past this margin it
    // is split first. Lower a number when a module shrinks; never raise one.
    const MARGIN = 40;
    const recorded: Record<string, number> = {
      "factory-tick.ts": 2314,
      "case-build.ts": 598,
      "review-wait.ts": 524,
      "verdict.ts": 463,
      "review-local.ts": 446,
      "inject.ts": 410,
    };
    const sizes = new Map(sourceModules().map((path) => [basename(path), lineCount(path)]));
    const grown = Object.entries(recorded).filter(([name, size]) => (sizes.get(name) ?? 0) > size + MARGIN);
    expect(grown).toEqual([]);
    expect(Object.keys(recorded).sort()).toEqual([...namedInRule()].sort());
  });

  it("names no module that is back under the limit", () => {
    const sizes = new Map(sourceModules().map((path) => [basename(path), lineCount(path)]));
    expect(namedInRule().filter((name) => (sizes.get(name) ?? 0) <= LIMIT)).toEqual([]);
  });
});

/**
 * The hooks' layout, checked instead of remembered: modules in folders by job with a README that maps them, test
 * files named for behaviour, the harness reached through one bridge, and a line budget.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const HOOKS = import.meta.dirname;
const ROOT = resolve(HOOKS, "../..");
const BRIDGE = "shared/harness-bridge.ts";

/**
 * The most lines the hooks' code (tests and fixtures.ts left out) may hold, so the guard stays small enough to
 * read whole. Raising it is a reviewed change: say in the PR why the code can't be made smaller instead.
 */
const LINE_BUDGET = 7_001;

/** Every `.ts` file under the hooks folder, relative to it, with `/`. */
const files = (readdirSync(HOOKS, { recursive: true }) as string[])
  .map((f) => f.replace(/\\/g, "/"))
  .filter((f) => f.endsWith(".ts") && !f.includes("node_modules/"));
const code = files.filter((f) => !f.endsWith(".test.ts") && f !== "fixtures.ts");
const folders = [...new Set(files.map((f) => posix.dirname(f)).filter((d) => d !== "."))].sort();

/** The relative imports in `text`, as written. */
const imports = (text: string) =>
  [...text.matchAll(/^(?:import|export)[^;]*? from "(\.[^"]+)";$/gm)].map((m) => m[1] ?? "");
/** The hook files `file` imports, relative to the hooks folder (`../…` for one outside it). */
const resolvedImports = (file: string) =>
  imports(readFileSync(join(HOOKS, file), "utf8")).map((spec) =>
    relative(HOOKS, resolve(HOOKS, dirname(file), spec)).replace(/\\/g, "/"),
  );

describe("the hooks' layout", () => {
  it("names no test file, and no describe block, after an audit or a review pass", () => {
    expect(files.filter((f) => /regrade|bypass|round/i.test(posix.basename(f)))).toEqual([]);
    const cited = files
      .filter((f) => f.endsWith(".test.ts"))
      .flatMap((f) =>
        [...readFileSync(join(HOOKS, f), "utf8").matchAll(/^describe\("([^"]*)"/gm)].map((m) => `${f}: ${m[1]}`),
      )
      .filter((line) => /\bAUD-[A-Z]\d|\(N-[A-C]\)|re-?grade|\bround \d/i.test(line.split(": ").slice(1).join(": ")));
    expect(cited).toEqual([]);
  });

  it("keeps only the entry points, their tests and the fixtures at the top; everything else sits in a folder", () => {
    const top = files.filter((f) => !f.includes("/")).filter((f) => !f.endsWith(".test.ts"));
    expect(top.sort()).toEqual([
      "factory-policy.ts",
      "fail-closed.ts",
      "fixtures.ts",
      "git-guard.ts",
      "guard-target.ts",
    ]);
  });

  it("imports one way between folders: entry points on top, shared/ and shell/ at the base, factory/ on the base only", () => {
    const wrong: string[] = [];
    for (const file of code) {
      const from = file.includes("/") ? (file.split("/")[0] ?? "") : "";
      for (const to of resolvedImports(file).filter((path) => !path.startsWith(".."))) {
        const folder = to.includes("/") ? (to.split("/")[0] ?? "") : "";
        if (folder === from) continue;
        const allowed =
          folder !== "" &&
          (from === "" ||
            ["shared", "shell"].includes(folder) ||
            (!["shared", "shell", "factory"].includes(from) && folder !== "factory"));
        if (!allowed) wrong.push(`${file} -> ${to}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("reaches the harness only through the bridge, which names each file it uses", () => {
    const outside = (file: string) => resolvedImports(file).filter((path) => path.startsWith(".."));
    expect(code.filter((f) => f !== BRIDGE && outside(f).length)).toEqual([]);
    const bridged = outside(BRIDGE);
    expect(bridged.length).toBeGreaterThan(0);
    const header = readFileSync(join(HOOKS, BRIDGE), "utf8").split("*/")[0] ?? "";
    for (const path of bridged) {
      expect(path).toMatch(/^\.\.\/\.\.\/packages\/harness\/src\/[\w-]+\/[\w-]+\.ts$/);
      expect(header).toContain(posix.basename(path));
    }
  });

  it("lets the harness's code use only the hook modules the README names for it", () => {
    const harness = join(ROOT, "packages", "harness", "src");
    const used = new Set<string>();
    for (const file of readdirSync(harness, { recursive: true }) as string[]) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      for (const spec of imports(readFileSync(join(harness, file), "utf8"))) {
        const path = relative(HOOKS, resolve(harness, dirname(file), spec)).replace(/\\/g, "/");
        if (!path.startsWith("..")) used.add(path);
      }
    }
    expect([...used].sort()).toEqual(["answer-key/private-ids.ts", "shared/repos.ts"]);
    const readme = readFileSync(join(HOOKS, "README.md"), "utf8");
    for (const path of used) expect(readme).toContain(path);
  });

  it("has a README under 80 lines that maps every folder", () => {
    const readme = readFileSync(join(HOOKS, "README.md"), "utf8");
    expect(readme.split("\n").length).toBeLessThan(80);
    for (const folder of folders) expect(readme).toContain(`${folder}/`);
  });

  it(`keeps the hooks' code within its line budget (${LINE_BUDGET} lines)`, () => {
    const lines = code.reduce((sum, f) => sum + readFileSync(join(HOOKS, f), "utf8").split("\n").length - 1, 0);
    expect(lines).toBeLessThanOrEqual(LINE_BUDGET);
  });
});

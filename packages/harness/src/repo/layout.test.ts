/**
 * The harness's layout, checked instead of remembered (#356): every module in an area folder, every `npm run`
 * script pointing at a file that exists, a short README in each area that names the areas it uses, and areas that
 * import one way, in the order `packages/harness/README.md` lists them.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC, sourceFiles } from "./sources.ts";

const ROOT = join(SRC, "../../..");
/** Folders under `src/` that hold test support, not an area. */
const SUPPORT = new Set(["fixtures"]);
const folders = readdirSync(SRC, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** The areas `packages/harness/README.md` lists, in its order: an area may use only those before it. */
function areaOrder(): string[] {
  const readme = readFileSync(join(SRC, "..", "README.md"), "utf8");
  return [...readme.matchAll(/^\| \d+ \| \[`([\w-]+)\/`\]/gm)].map((m) => m[1] ?? "");
}

/** The areas each area's code imports, statically or with a dynamic import. */
function areaImports(): Map<string, Set<string>> {
  const uses = new Map<string, Set<string>>();
  for (const file of sourceFiles()) {
    const from = file.split("/")[0] ?? "";
    const found = uses.get(from) ?? new Set<string>();
    uses.set(from, found);
    for (const m of readFileSync(join(SRC, file), "utf8").matchAll(/(?:from |import\()"(\.[^"]+)"/g)) {
      const to = relative(SRC, resolve(SRC, dirname(file), m[1] ?? "")).replace(/\\/g, "/");
      const area = to.split("/")[0] ?? "";
      if (!to.startsWith("..") && area !== from) found.add(area);
    }
  }
  return uses;
}

describe("the harness's layout (#356)", () => {
  it("keeps no module directly in src/: each sits in an area folder", () => {
    expect(readdirSync(SRC).filter((f) => f.endsWith(".ts"))).toEqual([]);
  });

  it("points every npm script at a file that exists", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const named = Object.values(pkg.scripts).flatMap((command) =>
      [...command.matchAll(/\bpackages\/harness\/[\w/.-]+\.ts\b/g)].map((m) => m[0]),
    );
    expect(named.length).toBeGreaterThan(20);
    expect(named.filter((path) => !existsSync(join(ROOT, path)))).toEqual([]);
  });

  it("gives each area a README under 40 lines that names the areas its code uses", () => {
    const uses = areaImports();
    for (const folder of folders) {
      const path = join(SRC, folder, "README.md");
      expect(existsSync(path), `${folder}/README.md`).toBe(true);
      const readme = readFileSync(path, "utf8");
      expect(readme.split("\n").length, `${folder}/README.md`).toBeLessThan(40);
      if (folder === "cli") continue; // It uses every area it starts, and says so.
      const line = readme.split("\n").find((l) => l.startsWith("Uses:")) ?? "";
      const listed = [...line.matchAll(/`([\w-]+)`/g)].map((m) => m[1]).sort();
      expect(listed, `${folder}/README.md: ${line}`).toEqual([...(uses.get(folder) ?? [])].sort());
    }
  });

  it("imports areas one way, in the order packages/harness/README.md lists them, so no cycle", () => {
    const order = areaOrder();
    expect([...order].sort()).toEqual(folders.filter((f) => !SUPPORT.has(f)));
    const wrong: string[] = [];
    for (const [from, used] of areaImports()) {
      for (const to of used)
        if (!(order.indexOf(to) >= 0 && order.indexOf(to) < order.indexOf(from))) wrong.push(`${from} -> ${to}`);
    }
    expect(wrong).toEqual([]);
  });
});

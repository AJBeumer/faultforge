/**
 * Real processes for `entry.ts` (AUD-N3): an error while a script's modules load, a link error, and an error
 * that escapes after `main` all end with the script's could-not-run code, never Node's default 1. The fixture
 * scripts are named after guarded scripts, so the table in `entry.ts` gives them a code.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ENTRY = join(ROOT, "packages", "harness", "src", "entry.ts");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Runs `<name>` from a fresh folder holding the given files, with `entry.ts` loaded first, as npm does. */
function run(name: string, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "entry-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  const result = spawnSync(process.execPath, [TSX, "--import", pathToFileURL(ENTRY).href, join(dir, name)], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stderr: result.stderr };
}

describe("entry.ts in a real process (AUD-N3)", () => {
  it("exits with the could-not-run code when a module throws while loading", () => {
    const { code, stderr } = run("docs-check.ts", {
      "docs-check.ts": 'import { ok } from "./broken.ts";\nconsole.log(ok);\n',
      "broken.ts": 'throw new Error("broken at load");\nexport const ok = 1;\n',
    });
    expect(stderr).toContain("docs-check.ts could not run: Error: broken at load");
    expect(code).toBe(2);
  });

  it("exits with the could-not-run code on a link error (an import that isn't exported)", () => {
    const { code, stderr } = run("factory-tick.ts", {
      "factory-tick.ts": 'import { missing } from "./lib.ts";\nconsole.log(missing);\n',
      "lib.ts": "export const present = 1;\n",
    });
    expect(stderr).toContain("factory-tick.ts could not run:");
    expect(stderr).toContain("missing");
    expect(code).toBe(3);
  });

  it("exits with the could-not-run code when an error escapes after main, from a timer", () => {
    const { code, stderr } = run("ticket-ready.ts", {
      "ticket-ready.ts": 'setTimeout(() => {\n  throw new Error("escaped later");\n}, 1);\n',
    });
    expect(stderr).toContain("ticket-ready.ts could not run: Error: escaped later");
    expect(code).toBe(2);
  });

  it("prints the failure once, though the script imports entry.ts too", () => {
    const { code, stderr } = run("guard-install.ts", {
      "guard-install.ts": `import "${pathToFileURL(ENTRY).href}";\nPromise.reject(new Error("unawaited"));\n`,
    });
    expect(stderr.match(/could not run/g)).toHaveLength(1);
    expect(code).toBe(2);
  });

  it("leaves a script that isn't guarded with Node's own behaviour", () => {
    const { code } = run("other.ts", { "other.ts": 'throw new Error("not guarded");\n' });
    expect(code).toBe(1);
  });
});

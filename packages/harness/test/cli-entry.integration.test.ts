/**
 * Real processes for the entry files on `cli-entry.ts` (AUD-N3): an error while the body's modules load, or a
 * link error in them, ends with the code the entry passes, never Node's default 1; and the moved scripts'
 * entries still reach their bodies and keep their own codes.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");
const SRC = join(ROOT, "packages", "harness", "src");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const tsx = (script: string, args: string[] = [], cwd = ROOT) => {
  const result = spawnSync(process.execPath, [TSX, script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
};

/** An entry written the way the moved scripts' are, beside a copy of `cli-entry.ts` and the given body files. */
function fixture(body: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "cli-entry-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  copyFileSync(join(SRC, "cli-entry.ts"), join(dir, "cli-entry.ts"));
  writeFileSync(
    join(dir, "x-cli.ts"),
    [
      'import { exitWhenWritten, runEntry } from "./cli-entry.ts";',
      "try {",
      '  await exitWhenWritten(await runEntry("x", async () => (await import("./x.ts")).main, process.argv.slice(2), 3));',
      "} catch {",
      "  process.exit(3);",
      "}",
      "",
    ].join("\n"),
  );
  for (const [file, text] of Object.entries(body)) writeFileSync(join(dir, file), text);
  return tsx(join(dir, "x-cli.ts"), [], dir);
}

describe("entries on cli-entry.ts, in a real process (AUD-N3)", () => {
  it("end with the entry's code when a module throws while loading", () => {
    const { code, err } = fixture({
      "x.ts": 'import "./broken.ts";\nexport const main = () => 0;\n',
      "broken.ts": 'throw new Error("broken at load");\n',
    });
    expect(err).toContain("x stopped on an unexpected error: Error: broken at load");
    expect(code).toBe(3);
  });

  it("end with the entry's code on a link error (an import that isn't exported)", () => {
    const { code, err } = fixture({
      "x.ts": 'import { missing } from "./lib.ts";\nexport const main = () => missing;\n',
      "lib.ts": "export const present = 1;\n",
    });
    expect(err).toContain("missing");
    expect(code).toBe(3);
  });

  it("keep the body's own code when it returns one", () => {
    expect(fixture({ "x.ts": "export const main = () => 1;\n" }).code).toBe(1);
  });

  it("end with the entry's code, the name and the stack when main throws or rejects", () => {
    const thrown = fixture({ "x.ts": 'export const main = () => {\n  throw new Error("in main");\n};\n' });
    expect(thrown.err).toMatch(/x stopped on an unexpected error: Error: in main\s+at /);
    expect(thrown.code).toBe(3);
    const rejected = fixture({ "x.ts": 'export const main = async () => {\n  throw new Error("later");\n};\n' });
    expect(rejected.err).toContain("x stopped on an unexpected error: Error: later");
    expect(rejected.code).toBe(3);
  });

  it("deliver a long output in full before exiting (Qodo on PR 277)", () => {
    const line = `${"x".repeat(99)}\n`;
    const { code, out } = fixture({
      "x.ts": `export const main = () => {\n  for (let i = 0; i < 40000; i++) process.stdout.write(${JSON.stringify(line)});\n  return 0;\n};\n`,
    });
    expect(code).toBe(0);
    expect(out.length).toBe(line.length * 40000);
  });

  it("reach the moved scripts' bodies, which keep their usage codes", () => {
    const timeline = tsx(join(SRC, "factory-timeline-cli.ts"));
    expect(timeline.err).toContain("usage: npm run factory:timeline");
    expect(timeline.code).toBe(2);
    const tick = tsx(join(SRC, "factory-tick-cli.ts"), ["--minutes", "soon"]);
    expect(tick.err).toContain("--minutes must be a positive number");
    expect(tick.code).toBe(2);
  });
});

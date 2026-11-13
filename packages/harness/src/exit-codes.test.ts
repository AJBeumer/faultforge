/**
 * The house rule that every script documents its exit codes, checked instead of remembered (audit N-2): a
 * file that calls `process.exit` must say "Exit codes:" in its header, and every code it can exit with
 * literally must be named there.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const SOURCES = [join(ROOT, "packages/harness/src"), join(ROOT, ".claude/hooks")];
// hook-io answers Claude Code's hook protocol for every hook; each hook's own header says what its codes mean.
const LIBRARIES = new Set(["hook-io.ts"]);

/** The file's first doc comment, wherever it starts: its header. */
const header = (text: string) => text.match(/\/\*\*[\s\S]*?\*\//)?.[0] ?? "";

function scripts(): { file: string; text: string }[] {
  return SOURCES.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !LIBRARIES.has(f))
      .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") })),
  ).filter(({ text }) => /process\.exit\(/.test(text));
}

describe("every script documents its exit codes (audit N-2)", () => {
  it("has an Exit codes section in its header comment", () => {
    const missing = scripts()
      .filter(({ text }) => !/Exit codes:/.test(header(text)))
      .map(({ file }) => file);
    expect(missing).toEqual([]);
  });

  it("names, in that section, every code it exits with literally", () => {
    const undocumented: string[] = [];
    for (const { file, text } of scripts()) {
      const top = header(text);
      const section = top.slice(top.indexOf("Exit codes:"));
      for (const [, code] of text.matchAll(/process\.exit\((\d)\)/g)) {
        if (!new RegExp(`\\b${code}\\b`).test(section)) undocumented.push(`${file}: ${code}`);
      }
    }
    expect([...new Set(undocumented)]).toEqual([]);
  });
});

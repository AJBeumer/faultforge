/**
 * The house rule that every script documents its exit codes, checked instead of remembered (audit N-2,
 * AUD-N3): a file that calls `process.exit`, and every script `package.json` runs, must say "Exit codes:" in its
 * header; every code it can exit with literally must be named there; and a script that npm runs must turn an
 * unexpected error into a code it documents, instead of Node's default 1, which most headers give another
 * meaning.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const SOURCES = [join(ROOT, "packages/harness/src"), join(ROOT, ".claude/hooks")];
// hook-io answers Claude Code's hook protocol for every hook; each hook's own header says what its codes mean.
const LIBRARIES = new Set(["hook-io.ts"]);

/**
 * Scripts npm runs whose uncaught errors still end as Node's default exit 1, which their headers use for
 * something else. Known on 14 November (AUD-N3); this list may only shrink, and a script leaves it once its entry catches. The fix is the one in
 * `rules-propose.ts`: catch around the entry, exit with the "could not run" code.
 */
const UNHANDLED_KNOWN = new Set([
  "case-build.ts",
  "case-review.ts",
  "case-ticket.ts",
  "docs-check.ts",
  "factory-tick.ts",
  "factory-timeline.ts",
  "guard-install.ts",
  "ledger-check.ts",
  "match.ts",
  "ticket-ready.ts",
  "verdict.ts",
]);

/** The file's first doc comment, wherever it starts: its header. */
const header = (text: string) => text.match(/\/\*\*[\s\S]*?\*\//)?.[0] ?? "";

function scripts(): { file: string; text: string }[] {
  return SOURCES.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !LIBRARIES.has(f))
      .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") })),
  ).filter(({ text }) => /process\.exit\(|process\.exitCode =/.test(text));
}

/** Every harness script a `package.json` script runs, by file name. */
function npmScripts(): { file: string; text: string }[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const files = new Set(
    Object.values(pkg.scripts).flatMap((command) =>
      [...command.matchAll(/packages\/harness\/src\/([\w-]+\.ts)/g)].map((m) => m[1] as string),
    ),
  );
  return [...files].map((file) => ({
    file,
    text: readFileSync(join(ROOT, "packages/harness/src", file), "utf8"),
  }));
}

/**
 * Whether an unexpected error reaches a documented code: the entry (the `process.argv[1]` block, or the whole
 * file when it runs on import) catches, or the file installs an `uncaughtException` handler.
 */
function handlesUnexpectedErrors(text: string): boolean {
  if (/process\.on\("uncaughtException"/.test(text)) return true;
  const guard = text.lastIndexOf("process.argv[1] &&");
  const entry = guard === -1 ? text : text.slice(guard);
  return /\bcatch\b/.test(entry);
}

describe("every script documents its exit codes (audit N-2, AUD-N3)", () => {
  it("has an Exit codes section in its header comment", () => {
    const missing = [...scripts(), ...npmScripts()]
      .filter(({ text }) => !/Exit codes:/.test(header(text)))
      .map(({ file }) => file);
    expect([...new Set(missing)]).toEqual([]);
  });

  it("names, in that section, every code it exits with literally", () => {
    const undocumented: string[] = [];
    for (const { file, text } of scripts()) {
      const top = header(text);
      const section = top.slice(top.indexOf("Exit codes:"));
      for (const [, code] of text.matchAll(/process\.exit(?:\(|Code = )(\d)\b/g)) {
        if (!new RegExp(`\\b${code}\\b`).test(section)) undocumented.push(`${file}: ${code}`);
      }
    }
    expect([...new Set(undocumented)]).toEqual([]);
  });

  it("turns an unexpected error into a documented code, in every script npm runs", () => {
    const unhandled = npmScripts()
      .filter(({ text }) => !handlesUnexpectedErrors(text))
      .map(({ file }) => file)
      .filter((file) => !UNHANDLED_KNOWN.has(file));
    expect(unhandled).toEqual([]);
  });

  it("tells a caught entry from one that lets an error escape", () => {
    const guard = "if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))";
    expect(handlesUnexpectedErrors(`${guard} main();`)).toBe(false);
    expect(handlesUnexpectedErrors(`try {} catch {}\n${guard} main();`)).toBe(false);
    expect(handlesUnexpectedErrors(`${guard} {\n  try { main(); } catch { process.exit(2); }\n}`)).toBe(true);
    expect(handlesUnexpectedErrors(`process.on("uncaughtException", () => process.exit(2));\nrun();`)).toBe(true);
  });
});

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
import { COULD_NOT_RUN } from "./entry.ts";

const ROOT = join(import.meta.dirname, "../../..");
const SOURCES = [join(ROOT, "packages/harness/src"), join(ROOT, ".claude/hooks")];
// hook-io answers Claude Code's hook protocol for every hook; each hook's own header says what its codes mean.
const LIBRARIES = new Set(["hook-io.ts"]);

/**
 * Scripts npm runs whose uncaught errors still end as Node's default exit 1, which their headers use for
 * something else. Known on 14 November (AUD-N3); this list may only shrink, and a script leaves it once its entry
 * catches. The fix: adopt `entry.ts` (see its header), which also catches errors while the script loads.
 */
const UNHANDLED_KNOWN = new Set([
  "case-build.ts",
  "case-review.ts",
  "case-ticket.ts",
  "ledger-check.ts",
  "match.ts",
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
  return /\bcatch\b|\brunEntry\(import\.meta\.url\b/.test(entry);
}

/** The part of a header's "Exit codes:" section that says what `code` means, up to the next code. */
function meaningOf(text: string, code: number): string {
  const top = header(text);
  const section = top.slice(top.indexOf("Exit codes:"));
  return section.match(new RegExp(`\\b${code}\\b(?:(?!\\b\\d\\b)[\\s\\S])*`))?.[0] ?? "";
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
    expect(handlesUnexpectedErrors(`${guard} await runEntry(import.meta.url, main);`)).toBe(true);
    expect(handlesUnexpectedErrors(`runEntry(import.meta.url, main);\n${guard} main();`)).toBe(false);
  });

  it("guards every script in entry.ts's table fully: entry, npm script and header (AUD-N3)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const problems: string[] = [];
    for (const [file, code] of Object.entries(COULD_NOT_RUN)) {
      const text = readFileSync(join(ROOT, "packages/harness/src", file), "utf8");
      if (!/process\.argv\[1\][^;]*\brunEntry\(import\.meta\.url, main\)/.test(text))
        problems.push(`${file}: its entry doesn't call runEntry`);
      const commands = Object.values(pkg.scripts).filter((c) => c.includes(`packages/harness/src/${file}`));
      if (!commands.length || commands.some((c) => !c.includes(`--import ./packages/harness/src/entry.ts`)))
        problems.push(`${file}: npm doesn't load entry.ts first`);
      if (!/entry\.ts/.test(meaningOf(text, code)))
        problems.push(`${file}: its header doesn't say ${code} is entry.ts's`);
    }
    // And the other way: a script calling runEntry without a code would throw at its first run.
    for (const { file, text } of npmScripts())
      if (/\brunEntry\(/.test(text) && file !== "entry.ts" && !(file in COULD_NOT_RUN))
        problems.push(`${file}: calls runEntry but has no code in entry.ts`);
    expect(problems).toEqual([]);
  });

  it("reads a code's meaning up to the next code", () => {
    const text = "/**\n * Exit codes: 0 fine; 2 broken (`entry.ts`); 3 other.\n */";
    expect(meaningOf(text, 2)).toContain("entry.ts");
    expect(meaningOf(text, 0)).not.toContain("entry.ts");
    expect(meaningOf(text, 3)).not.toContain("entry.ts");
  });
});

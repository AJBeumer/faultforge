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
      .map(({ file }) => file);
    expect(unhandled).toEqual([]);
  });

  it("tells a caught entry from one that lets an error escape", () => {
    const guard = "if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))";
    expect(handlesUnexpectedErrors(`${guard} main();`)).toBe(false);
    expect(handlesUnexpectedErrors(`try {} catch {}\n${guard} main();`)).toBe(false);
    expect(handlesUnexpectedErrors(`${guard} {\n  try { main(); } catch { process.exit(2); }\n}`)).toBe(true);
    expect(handlesUnexpectedErrors(`process.on("uncaughtException", () => process.exit(2));\nrun();`)).toBe(true);
  });

  it("catches load-time errors too: an entry on cli-entry.ts imports nothing else statically (AUD-N3)", () => {
    const problems: string[] = [];
    const entries = npmScripts().filter(({ text }) => /from "\.\/cli-entry\.ts"/.test(text));
    for (const { file, text } of entries) {
      const imports = [...text.matchAll(/^import [^;]*? from "(.+)";$/gm)].map((m) => m[1]);
      if (imports.join() !== "./cli-entry.ts") problems.push(`${file} imports ${imports.join(", ")}`);
      if (!/await runEntry\(\s*"[\w:]+",\s*async \(\) =>[^;]*\(await import\("\.\/[\w-]+\.ts"\)\)/.test(text))
        problems.push(`${file} doesn't load its body inside runEntry`);
    }
    // The scripts moved behind cli-entry.ts for AUD-N3 stay there, and each body's header says where its
    // could-not-run code comes from, so a reader of either file finds it.
    const moved = {
      "case-build": 2,
      "case-pr": 2,
      "case-rerun": 2,
      "case-review": 2,
      "case-ticket": 2,
      "docs-check": 2,
      "factory-tick": 3,
      "factory-timeline": 2,
      "guard-install": 2,
      "ledger-check": 2,
      match: 2,
      "ticket-ready": 2,
      verdict: 2,
      "verdict-amend": 2,
    };
    for (const [name, code] of Object.entries(moved)) {
      const cli = entries.find(({ file }) => file === `${name}-cli.ts`);
      if (!cli) problems.push(`npm doesn't run ${name}-cli.ts`);
      else if (!new RegExp(`process\\.argv\\.slice\\(2\\),\\s*${code},?\\s*\\)`).test(cli.text))
        problems.push(`${name}-cli.ts doesn't pass ${code} to runEntry`);
      const top = header(readFileSync(join(ROOT, "packages/harness/src", `${name}.ts`), "utf8"));
      const section = top.slice(top.indexOf("Exit codes:"));
      if (!new RegExp(`\\b${code}\\b[\\s\\S]*${name}-cli\\.ts`).test(section))
        problems.push(`${name}.ts's header doesn't say ${code} is also an unexpected error (${name}-cli.ts)`);
    }
    expect(problems).toEqual([]);
  });
});

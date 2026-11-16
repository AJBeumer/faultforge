/**
 * The hooks' comments, test names and file names explain the code, not how it came to be. History belongs in git
 * and the decision log, where it stays true; in a comment it goes stale and hides the reason.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HOOKS = import.meta.dirname;

/** A ticket or PR number, a review round, a grading pass, an audit id, a reviewer's finding or a commit id. */
const HISTORY = new RegExp(
  [
    String.raw`#\d+`,
    String.raw`\bPRs? #?\d+`,
    String.raw`\bAUD-[A-Z]+\d+`,
    String.raw`\baudit [A-Z]+-\d+`,
    String.raw`\([A-Z]-[A-Z]\)`,
    String.raw`\bN-\d+\b`,
    String.raw`re-?grade`,
    String.raw`\bround \d+`,
    String.raw`\b(?:first|second|third|fourth|fifth|\d+(?:st|nd|rd|th)) (?:round|review)\b`,
    String.raw`\bQodo(?:,| on\b| found\b|'s (?:review|finding|example))`,
    String.raw`\bfinding \d+`,
    String.raw`\bbypass[- ]?\d+`,
    String.raw`\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b`,
  ].join("|"),
  "i",
);

const files = (readdirSync(HOOKS, { recursive: true }) as string[])
  .map((f) => f.replace(/\\/g, "/"))
  .filter((f) => /\.(ts|md)$/.test(f) && !f.includes("node_modules/"));

/** The comment text in a TypeScript file: whole comment lines, block comment lines and trailing `//` comments. */
function comments(text: string): string[] {
  const found: string[] = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (inBlock || trimmed.startsWith("/*")) {
      found.push(trimmed);
      inBlock = !trimmed.includes("*/");
      continue;
    }
    const trailing = /(?:^|\s)\/\/(.*)$/.exec(line);
    if (trailing) found.push(trailing[1] ?? "");
  }
  return found;
}

/** The names given to `describe`, `it` and `test`, including the `it.each(...)("name")` form. */
const testNames = (text: string) =>
  [...text.matchAll(/(?:\b(?:describe|it|test)(?:\.\w+)*\(|\)\()\s*(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g)].map(
    (m) => m[2] ?? "",
  );

/** Each place in `file` that names history, as `file: text`. */
function historyIn(file: string): string[] {
  const text = readFileSync(join(HOOKS, file), "utf8");
  const read = file.endsWith(".md") ? text.split(/\r?\n/) : [...comments(text), ...testNames(text)];
  return [file, ...read].filter((line) => HISTORY.test(line)).map((line) => `${file}: ${line}`);
}

describe("history kept out of the hooks' comments and names", () => {
  it.each([
    "see #123",
    "Qodo on PR 312",
    "re-grade 9",
    "the second round",
    "(AUD-M3)",
    "audit N-4",
    "(N-A)",
    "fixed in 2e15454",
  ])("recognises %s as history", (sample) => {
    expect(HISTORY.test(sample)).toBe(true);
  });

  it.each(["a quote inside a name changes nothing", "exit code 2", "FF-9001", "the facade"])(
    "doesn't take %s for history",
    (sample) => {
      expect(HISTORY.test(sample)).toBe(false);
    },
  );

  it("finds comments, test names and file names to scan", () => {
    const sample = '// a\nconst x = 1; // b\n/**\n * c\n */\nit("d", () => {});\nit.each([1])("e %s", f);';
    expect(comments(sample)).toEqual([" a", " b", "/**", "* c", "*/"]);
    expect(testNames(sample)).toEqual(["d", "e %s"]);
  });

  it("names no ticket, PR, review round, grading pass, audit id, reviewer finding or commit in any comment, test name or file name", () => {
    expect(files.flatMap(historyIn)).toEqual([]);
  });
});

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

/** After one of these, a `/` starts a regular expression, not a division. */
const BEFORE_REGEX = /[(,=:[!&|?{};+\-*%<>~^]/;
const KEYWORD_BEFORE_REGEX = /\b(?:return|typeof|case|in|of|void|delete|throw|new|yield|await)\s*$/;

/**
 * The comment text in a TypeScript file, one entry per line, wherever on a line a comment starts. Strings,
 * templates and regular expressions are skipped, so a `//` or `/*` inside one is not taken for a comment.
 */
function comments(text: string): string[] {
  const found: string[] = [];
  const interpolations: number[] = []; // open braces inside each `${`, innermost last
  let prev = "";
  let i = 0;
  const skipTemplate = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") i += 2;
      else if (c === "`") return void i++;
      else if (c === "$" && text[i + 1] === "{") {
        i += 2;
        interpolations.push(0);
        return;
      } else i++;
    }
  };
  const skipRegex = () => {
    let inClass = false;
    for (i++; i < text.length && text[i] !== "\n"; i++) {
      const c = text[i];
      if (c === "\\") i++;
      else if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) return void i++;
    }
  };
  while (i < text.length) {
    const c = text[i] ?? "";
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      found.push(text.slice(i + 2, stop).trim());
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      found.push(
        ...text
          .slice(i, stop)
          .split(/\r?\n/)
          .map((line) => line.trim()),
      );
      i = stop;
    } else if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c && text[i] !== "\n"; i++) if (text[i] === "\\") i++;
      i++;
      prev = c;
    } else if (c === "`" || (c === "}" && interpolations.at(-1) === 0)) {
      if (c === "}") interpolations.pop();
      i++;
      skipTemplate();
      prev = "`";
    } else if (
      c === "/" &&
      (prev === "" || BEFORE_REGEX.test(prev) || KEYWORD_BEFORE_REGEX.test(text.slice(Math.max(0, i - 16), i)))
    ) {
      skipRegex();
      prev = "a";
    } else {
      const open = interpolations.length - 1;
      if (open >= 0 && c === "{") interpolations[open] = (interpolations[open] ?? 0) + 1;
      if (open >= 0 && c === "}") interpolations[open] = (interpolations[open] ?? 1) - 1;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
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
    expect(comments(sample)).toEqual(["a", "b", "/**", "* c", "*/"]);
    expect(testNames(sample)).toEqual(["d", "e %s"]);
  });

  it("finds a comment that starts after code on the same line", () => {
    expect(comments("const result = decide(input); /* see #1 */")).toEqual(["/* see #1 */"]);
    expect(comments("const x = 1;// see #2")).toEqual(["see #2"]);
  });

  it("doesn't take a // or /* inside a string, template or regular expression for a comment", () => {
    const sample = [
      `const url = "https://example.com/#3";`,
      `const glob = 'a/*b';`,
      "const t = `x // ${y ? `/* ${z} */` : '//'} #4`;",
      "const re = /\\/\\/#5|[/*]/g; // after",
      "const half = total / 2; const r = (a) / 3; return /x\\/*y/.test(s);",
    ].join("\n");
    expect(comments(sample)).toEqual(["after"]);
  });

  it("names no ticket, PR, review round, grading pass, audit id, reviewer finding or commit in any comment, test name or file name", () => {
    expect(files.flatMap(historyIn)).toEqual([]);
  });
});

/**
 * Comments, test names, file names and area READMEs in these areas say why, not when: a review round, an audit
 * id, a PR or ticket number means nothing to a reader without the history, and git and the decision log keep it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC } from "./sources.ts";

const AREAS = ["factory", "guard", "door", "shared", "cli", "repo", "fixtures", "docs"];

/** Words that point at the project's history instead of explaining the code. */
const HISTORY: { what: string; pattern: RegExp }[] = [
  { what: "a re-grade", pattern: /\bre-?grades?\b/i },
  { what: "a review round", pattern: /\brounds? \d+/i },
  { what: "an audit id", pattern: /\bAUD-|\baudit [A-Z]{1,3}-?\d+|\([HLMN]-?\d+[a-z]?\)/i },
  { what: "a PR number", pattern: /\b(?:PR|pull request)s? ?#?\d+/i },
  { what: "an issue or PR number", pattern: /(?:^|[\s(,;[])#\d+\b/ },
  { what: "a ticket, issue or finding number", pattern: /\b(?:ticket|issue|finding)s? #?\d+/i },
  {
    what: "a reviewer's finding",
    pattern: /\bQodo(?:'s)? (?:on|first|second|third|later|earlier) |\breviewer finding/i,
  },
];

const NAME_HISTORY = /re-?grade|round-?\d|bypass-?\d|\bpr-?\d|aud-|issue-?\d|ticket-?\d|finding-?\d/i;

/** The comment text of a TypeScript source: every line and block comment outside a string or regex literal. */
function commentLines(source: string): string[] {
  const found: string[] = [];
  let inBlock = false;
  for (const line of source.split(/\r?\n/)) {
    let i = 0;
    if (inBlock) {
      const end = line.indexOf("*/");
      found.push(line.slice(0, end < 0 ? undefined : end + 2).trim());
      if (end < 0) continue;
      inBlock = false;
      i = end + 2;
    }
    // A string or a regex literal ends on its own line here, which holds for this codebase's style.
    let quote = "";
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === "\\") i++;
      else if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "/" && line[i + 1] === "/") {
        found.push(line.slice(i).trim());
        break;
      } else if (c === "/" && line[i + 1] === "*") {
        const end = line.indexOf("*/", i + 2);
        found.push(line.slice(i, end < 0 ? undefined : end + 2).trim());
        if (end < 0) {
          inBlock = true;
          break;
        }
        i = end + 1;
      } else if (c === "/" && /(?:^|[(,=:[!&|?{};]|return)\s*$/.test(line.slice(0, i))) i = regexEnd(line, i);
    }
  }
  return found;
}

/** The index of the `/` that closes the regex literal starting at `start`. */
function regexEnd(line: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") i++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i;
  }
  return line.length;
}

/** The index just past the bracket that closes the one at `open`, skipping strings. */
function closingParen(source: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") i++;
    else if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return source.length;
}

/** The titles given to `describe`, `it` and `test`, with any modifiers such as `.skipIf(...)` or `.each(...)`. */
function testTitles(source: string): string[] {
  const titles: string[] = [];
  for (const m of source.matchAll(/\b(?:describe|it|test)\b(?=[.(])/g)) {
    let i = (m.index ?? 0) + m[0].length;
    for (;;) {
      const modifier = /^\.\w+/.exec(source.slice(i));
      if (modifier) i += modifier[0].length;
      else if (source[i] === "(") {
        const title = /^\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/.exec(source.slice(i));
        if (title) {
          titles.push(title[2] ?? "");
          break;
        }
        i = closingParen(source, i);
      } else break;
    }
  }
  return titles;
}

/** Each place in the areas that names history, as `file: what (text)`. */
function historyFound(): string[] {
  const found: string[] = [];
  const check = (where: string, text: string) => {
    for (const { what, pattern } of HISTORY) if (pattern.test(text)) found.push(`${where}: ${what} (${text.trim()})`);
  };
  for (const area of AREAS) {
    for (const name of readdirSync(join(SRC, area))) {
      const where = `${area}/${name}`;
      if (NAME_HISTORY.test(name)) found.push(`${where}: a file name that names history`);
      // This file's own examples are history on purpose.
      if (name === "plain-history-free-text.test.ts") continue;
      const text = readFileSync(join(SRC, area, name), "utf8");
      if (name.endsWith(".md")) for (const line of text.split(/\r?\n/)) check(where, line);
      else if (name.endsWith(".ts"))
        for (const line of [...commentLines(text), ...testTitles(text)]) check(where, line);
    }
  }
  return found;
}

const names = (text: string) => HISTORY.filter(({ pattern }) => pattern.test(text)).map(({ what }) => what);

describe("comments, test names and file names that say why, not when", () => {
  it("finds no review round, audit id, PR, ticket or finding number in these areas", () => {
    expect(historyFound()).toEqual([]);
  });

  it("recognises each kind of history it looks for", () => {
    expect(names("Re-grade 7: a name slipped past here")).toEqual(["a re-grade"]);
    expect(names("found in round 12")).toEqual(["a review round"]);
    expect(names("see AUD-M3")).toEqual(["an audit id"]);
    expect(names("(audit N-15)")).toEqual(["an audit id"]);
    expect(names("as git spells paths (N-12)")).toEqual(["an audit id"]);
    expect(names("the leftover id (M45d)")).toEqual(["an audit id"]);
    expect(names("Qodo on PR 236")).toEqual(["a PR number", "a reviewer's finding"]);
    expect(names("as asked in #245")).toEqual(["an issue or PR number"]);
    expect(names("ticket 12 asked for it")).toEqual(["a ticket, issue or finding number"]);
    expect(names("Qodo's second review saw it")).toEqual(["a reviewer's finding"]);
  });

  it("leaves ordinary words and data alone", () => {
    expect(names("Expand variables first: a repo name can hide in one.")).toEqual([]);
    expect(names('"owner/target#18"')).toEqual([]);
    expect(names("rounds the time down to a second")).toEqual([]);
    expect(names("Qodo's review is saved as evidence")).toEqual([]);
  });

  it("reads whole-line, trailing and block comments, and nothing else", () => {
    const source = [
      "/**",
      " * A header.",
      " */",
      'const url = "https://example.com"; // a trailing note',
      "// a line note",
      'const s = "not // a comment";',
    ].join("\n");
    expect(commentLines(source)).toEqual(["/**", "* A header.", "*/", "// a trailing note", "// a line note"]);
  });

  it("reads a comment in the middle of code or with no space after its slashes", () => {
    const source = [
      "const a = 1 /* an inline note */ + 2;",
      "const b = 3; //a tight note",
      "const c = /\\/\\//.test(x); // after a regex",
      'const d = "/* not a comment */";',
    ].join("\n");
    expect(commentLines(source)).toEqual(["/* an inline note */", "//a tight note", "// after a regex"]);
  });

  it("reads test titles, also after a modifier and on the next line", () => {
    const source = [
      'describe("a group", () => {',
      '  it.skipIf(process.env.CI !== undefined)("a skipped case", () => {});',
      "  it(",
      '    "a long case",',
      "    () => {},",
      "  );",
      "  test.each([1])(`case %s`, () => {});",
      "  it.each(KINDS.filter((k) => !(ALLOWED as readonly string[]).includes(k)))(",
      '    "a nested case %s",',
      "    () => {},",
      "  );",
      "});",
    ].join("\n");
    expect(testTitles(source)).toEqual(["a group", "a skipped case", "a long case", "case %s", "a nested case %s"]);
  });

  it("flags a file name that names history", () => {
    expect(NAME_HISTORY.test("regrade9.test.ts")).toBe(true);
    expect(NAME_HISTORY.test("bypass-2.test.ts")).toBe(true);
    expect(NAME_HISTORY.test("quoted-repo-names.test.ts")).toBe(false);
    expect(NAME_HISTORY.test("ticket-snapshot.ts")).toBe(false);
  });
});

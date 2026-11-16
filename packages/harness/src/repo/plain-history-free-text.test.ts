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

/** The comment text of a TypeScript source: whole-line, trailing and block comments. */
function commentLines(source: string): string[] {
  const found: string[] = [];
  let inBlock = false;
  for (const line of source.split(/\r?\n/)) {
    const t = line.trim();
    if (inBlock) {
      found.push(t);
      if (t.includes("*/")) inBlock = false;
    } else if (t.startsWith("//")) found.push(t);
    else if (t.startsWith("/*")) {
      found.push(t);
      inBlock = !t.includes("*/");
    } else {
      const trailing = trailingComment(t);
      if (trailing) found.push(trailing);
    }
  }
  return found;
}

/** A `// note` after code, but not one inside a string: the quotes before it must all be closed. */
function trailingComment(line: string): string | undefined {
  for (const m of line.matchAll(/\s\/\/\s/g)) {
    const before = line.slice(0, m.index).replace(/\\./g, "");
    const open = ['"', "'", "`"].some((q) => before.split(q).length % 2 === 0);
    if (!open) return line.slice((m.index ?? 0) + 1);
  }
  return undefined;
}

/** The titles given to `describe`, `it` and `test`, with any modifier such as `.skipIf(...)` or `.each`. */
function testTitles(source: string): string[] {
  const call = /\b(?:describe|it|test)(?:\.\w+(?:\((?:[^()]|\([^()]*\))*\))?)*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  return [...source.matchAll(call)].map((m) => m[2] ?? "");
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

  it("reads test titles, also after a modifier and on the next line", () => {
    const source = [
      'describe("a group", () => {',
      '  it.skipIf(process.env.CI !== undefined)("a skipped case", () => {});',
      "  it(",
      '    "a long case",',
      "    () => {},",
      "  );",
      "  test.each([1])(`case %s`, () => {});",
      "});",
    ].join("\n");
    expect(testTitles(source)).toEqual(["a group", "a skipped case", "a long case", "case %s"]);
  });

  it("flags a file name that names history", () => {
    expect(NAME_HISTORY.test("regrade9.test.ts")).toBe(true);
    expect(NAME_HISTORY.test("bypass-2.test.ts")).toBe(true);
    expect(NAME_HISTORY.test("quoted-repo-names.test.ts")).toBe(false);
    expect(NAME_HISTORY.test("ticket-snapshot.ts")).toBe(false);
  });
});

/**
 * Comments, test names and file names in the case, verdict, ledger, inject, match, qodo, review, rules and
 * tickets areas, and in the integration tests, say why the code is as it is. Where a change came from belongs in
 * git and the decision log, so this scan refuses review rounds, audit ids, and pull request or ticket numbers.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const HARNESS = join(import.meta.dirname, "../..");
const AREAS = ["case", "verdict", "ledger", "inject", "match", "qodo", "review", "rules", "tickets"];
const FOLDERS = [...AREAS.map((area) => join(HARNESS, "src", area)), join(HARNESS, "test")];

const HISTORY: RegExp[] = [
  // Not followed by a letter, so a number glued to the word in a file name is caught too.
  /\bre-?grades?(?![a-z])/i,
  // A space, hyphen or underscore before the number, as file names join words.
  /\brounds?[ _-]?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i,
  /\bAUD-[A-Z]*\d+/,
  /(?<![-\w])([CHMN]-?\d{1,3}[a-f]?|L-\d{1,3}|I\d{2})\b/,
  /#\d+\b/,
  /\b(PR|pull request|issue|ticket|finding) #?\d+\b/i,
  /\b(first|second|third|fourth|fifth|\d+(st|nd|rd|th)) (Qodo )?review\b/i,
  /\bQodo (on|found|flagged|said|noted|caught|pointed out)\b/i,
];

/** The history words a piece of text names, if any. */
function historyIn(text: string): string[] {
  return HISTORY.flatMap((pattern) => pattern.exec(text)?.[0] ?? []);
}

/** Every comment in a TypeScript source: whole-line and trailing line comments, and block comments. */
function commentsIn(source: string): string[] {
  const blocks = [...source.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0]);
  // Not after a colon, so a URL's `https://` is not taken for a comment. No space is needed before it.
  const lines = [...source.matchAll(/(?<!:)\/\/(.*)$/gm)].map((m) => m[1] ?? "");
  return [...blocks, ...lines];
}

/**
 * The title of every `describe`, `it` and `test` call, including `.skip` and `.skipIf(...)` forms. For `.each`,
 * every string in its rows too: a row's value can become part of the title through `%s` or `$name`.
 */
function testNamesIn(source: string): string[] {
  const calls = /\b(?:describe|it|test)(?:\.\w+(?:\([^)]*\))?)*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  const titles = [...source.matchAll(calls)].map((m) => m[2] ?? "");
  return [...titles, ...eachRowStrings(source)];
}

/** Every string literal in the argument of a `describe.each`, `it.each` or `test.each` call. */
function eachRowStrings(source: string): string[] {
  const strings: string[] = [];
  for (const m of source.matchAll(/\b(?:describe|it|test)(?:\.\w+)*\.each\(/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const rows: string[] = [];
    let depth = 1;
    let end = start;
    while (end < source.length && depth > 0) {
      const char = source[end];
      if (char === '"' || char === "'" || char === "`") {
        const close = new RegExp(`^${char}(?:\\\\.|[^${char}\\\\])*${char}`).exec(source.slice(end));
        const literal = close?.[0] ?? char;
        rows.push(literal.slice(1, -1));
        end += literal.length;
        continue;
      }
      if ("([{".includes(char ?? "")) depth++;
      if (")]}".includes(char ?? "")) depth--;
      end++;
    }
    // The title follows the rows; the general pattern can't reach it past a bracket inside them.
    const title = /^\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(source.slice(end));
    strings.push(...(title ? [title[2] ?? ""] : []), ...rows);
  }
  return strings;
}

/** Every file under `dir`, of any type: a README's name can carry history as easily as a module's. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("the history scan", () => {
  it("finds review rounds, audit ids, and pull request and ticket numbers", () => {
    expect(historyIn("Re-grade 7: a name slipped past (AUD-M3), see #340")).toEqual(["Re-grade", "AUD-M3", "#340"]);
    expect(historyIn("Qodo's second review, round 12")).toEqual(["round 12", "second review"]);
    expect(historyIn("fixed in PR 344 after finding 3")).toEqual(["PR 344"]);
    expect(historyIn("finding 3 of issue 9")).toEqual(["finding 3"]);
    expect(historyIn("untrimmed (audit N-14), as Qodo flagged")).toEqual(["N-14", "Qodo flagged"]);
    expect(historyIn("the ids M44b and I07")).toEqual(["M44b"]);
    expect(historyIn("as I07 says")).toEqual(["I07"]);
  });

  it("finds review rounds in file names, whatever joins the words", () => {
    expect(historyIn("case/review-round-9.test.ts")).toEqual(["round-9"]);
    expect(historyIn("case/round_3.md")).toEqual(["round_3"]);
    expect(historyIn("case/regrade9.test.ts")).toEqual(["regrade"]);
  });

  it("passes a plain reason", () => {
    expect(historyIn("Expand variables first: a repo name can hide in one.")).toEqual([]);
    expect(historyIn("a round trip through JSON keeps the order")).toEqual([]);
    expect(historyIn("case FF-12 and template x-secret-v1 are made-up fixtures")).toEqual([]);
    expect(historyIn("drop main's L3, keep line L1")).toEqual([]);
  });

  it("reads trailing and block comments, and titles with quotes of every kind", () => {
    const source = 'const a = "http://x"; // why\n/** block */\nit.skipIf(x)("one", () => {});\ndescribe(`two`, f);';
    expect(commentsIn(source)).toEqual(["/** block */", " why"]);
    expect(testNamesIn(source)).toEqual(["one", "two"]);
  });

  it("reads a trailing comment with no space before it", () => {
    expect(commentsIn("x();// why\nconst u = 'https://example.com';")).toEqual([" why"]);
  });

  it("reads the rows of an each call, since a row's value can become part of the title", () => {
    const source = 'it.each([\n  ["a row (with a note)", { x: [1, 2] }],\n  ["another"],\n])("refuses %s", f);';
    expect(testNamesIn(source)).toEqual(["refuses %s", "a row (with a note)", "another"]);
  });
});

describe("comments, test names and file names in these areas", () => {
  for (const folder of FOLDERS) {
    it(`name no review round, audit id, pull request or ticket in ${relative(HARNESS, folder)}`, () => {
      const found: string[] = [];
      for (const file of files(folder)) {
        const name = relative(HARNESS, file).replace(/\\/g, "/");
        for (const hit of historyIn(name)) found.push(`${name}: file name has ${hit}`);
        if (!file.endsWith(".ts")) continue;
        const source = readFileSync(file, "utf8");
        for (const text of [...commentsIn(source), ...testNamesIn(source)])
          for (const hit of historyIn(text)) found.push(`${name}: ${hit} in "${text.trim().slice(0, 80)}"`);
      }
      expect(found).toEqual([]);
    });
  }
});

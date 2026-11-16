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
  /\bre-?grades?\b/i,
  /\brounds? (\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i,
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
  const lines = [...source.matchAll(/(?:^|\s)\/\/(.*)$/gm)].map((m) => m[1] ?? "");
  return [...blocks, ...lines];
}

/** The title of every `describe`, `it` and `test` call, including `.each`, `.skip` and `.skipIf(...)` forms. */
function testNamesIn(source: string): string[] {
  const calls = /\b(?:describe|it|test)(?:\.\w+(?:\([^)]*\))?)*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  return [...source.matchAll(calls)].map((m) => m[2] ?? "");
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
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
});

describe("comments, test names and file names in these areas", () => {
  for (const folder of FOLDERS) {
    it(`name no review round, audit id, pull request or ticket in ${relative(HARNESS, folder)}`, () => {
      const found: string[] = [];
      for (const file of sources(folder)) {
        const name = relative(HARNESS, file).replace(/\\/g, "/");
        const source = readFileSync(file, "utf8");
        for (const hit of historyIn(name)) found.push(`${name}: file name has ${hit}`);
        for (const text of [...commentsIn(source), ...testNamesIn(source)])
          for (const hit of historyIn(text)) found.push(`${name}: ${hit} in "${text.trim().slice(0, 80)}"`);
      }
      expect(found).toEqual([]);
    });
  }
});

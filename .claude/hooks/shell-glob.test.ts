/** Shell wildcards and brace lists, expanded against made-up folders under the temp folder (Qodo on PR 310). */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { braces, globMatches, hasWildcard, MAX_MATCHES } from "./shell-glob.ts";

const ROOT = mkdtempSync(join(tmpdir(), "shell-glob-"));
mkdirSync(join(ROOT, "private", "cases"), { recursive: true });
mkdirSync(join(ROOT, "docs"));
writeFileSync(join(ROOT, "private", "cases", "FF-9001.json"), "{}");
writeFileSync(join(ROOT, "private", "ground-truth.jsonl"), "{}");
writeFileSync(join(ROOT, "docs", "a.md"), "x");

describe("braces", () => {
  it("expands lists, nested ones too, and leaves a list with no comma as written", () => {
    expect(braces("a{b,c}d")).toEqual(["abd", "acd"]);
    expect(braces("{x,y{1,2}}")).toEqual(["x", "y1", "y2"]);
    expect(braces("a{b}c")).toEqual(["a{b}c"]);
    expect(braces("plain")).toEqual(["plain"]);
  });
});

describe("globMatches", () => {
  it.each([
    ["priv*/cases/FF-9001.json", [join(ROOT, "private", "cases", "FF-9001.json")]],
    ["*/ground-truth.jsonl", [join(ROOT, "private", "ground-truth.jsonl")]],
    ["priv?te", [join(ROOT, "private")]],
    ["p[r]ivate/g*", [join(ROOT, "private", "ground-truth.jsonl")]],
    ["p[!x]ivate", [join(ROOT, "private")]],
    ["{private,docs}/a.md", [join(ROOT, "docs", "a.md")]],
    ["*/package.json", []],
  ])("%s matches what the shell would", (word, expected) => {
    expect(globMatches(word, ROOT)?.sort()).toEqual(expected);
  });

  it("matches an absolute pattern", () => {
    expect(globMatches(join(ROOT, "doc*", "*.md").replace(/\\/g, "/"), "/")).toEqual([join(ROOT, "docs", "a.md")]);
  });

  it("says when there are too many entries to look at", () => {
    const wide = mkdtempSync(join(tmpdir(), "shell-glob-wide-"));
    for (let i = 0; i <= MAX_MATCHES; i++) writeFileSync(join(wide, `f${i}`), "");
    expect(globMatches("*", wide)).toBeUndefined();
  });

  it("knows a wildcard word", () => {
    expect(["a*", "a?", "a[b]", "{a,b}"].every(hasWildcard)).toBe(true);
    expect(hasWildcard("plain/path.txt")).toBe(false);
  });
});

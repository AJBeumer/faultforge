import { describe, expect, it } from "vitest";
import { applyPatch, patchProblem, replacementPatch } from "./proof-patch.ts";

describe("replacementPatch", () => {
  const text = "one\ntwo\nthree\n";
  it("turns replaced lines into a patch that applies and stays inside them", () => {
    const patch = replacementPatch(text, "f.ts", { start: 2, end: 2, lines: ["TWO", "2b"] }) as string;
    expect(applyPatch(text, patch)).toBe("one\nTWO\n2b\nthree\n");
    expect(patchProblem(patch, { file: "f.ts", start: 2, end: 2 })).toBeNull();
    expect(patchProblem(patch, { file: "f.ts", start: 3, end: 3 })).toMatch(/outside/);
  });
  it("keeps a new line that starts with ++ inside the hunk, not as a file header", () => {
    const patch = replacementPatch(text, "f.ts", { start: 2, end: 2, lines: ["++ x", "-- y"] }) as string;
    expect(patchProblem(patch, { file: "f.ts", start: 2, end: 2 })).toBeNull();
    expect(applyPatch(text, patch)).toBe("one\n++ x\n-- y\nthree\n");
  });
  it("deletes lines when the replacement is empty", () => {
    const patch = replacementPatch(text, "f.ts", { start: 2, end: 3, lines: [] }) as string;
    expect(applyPatch(text, patch)).toBe("one\n");
  });
  it("refuses lines the file doesn't have", () => {
    expect(replacementPatch(text, "f.ts", { start: 0, end: 1, lines: [] })).toBeNull();
    expect(replacementPatch(text, "f.ts", { start: 3, end: 2, lines: [] })).toBeNull();
    expect(replacementPatch(text, "f.ts", { start: 2, end: 9, lines: [] })).toBeNull();
  });
});

describe("applyPatch", () => {
  const text = "one\ntwo\nthree\nfour\n";
  const p = (hunk: string) => `--- a/f\n+++ b/f\n${hunk}`;
  it("replaces, adds and removes lines at the hunk's position", () => {
    expect(applyPatch(text, p("@@ -2,2 +2,2 @@\n two\n-three\n+THREE\n"))).toBe("one\ntwo\nTHREE\nfour\n");
    expect(applyPatch(text, p("@@ -1,0 +2,1 @@\n+new\n"))).toBe("one\nnew\ntwo\nthree\nfour\n");
    expect(applyPatch(text, p("@@ -4,1 +3,0 @@\n-four\n"))).toBe("one\ntwo\nthree\n");
  });
  it("refuses a hunk whose lines don't match exactly", () => {
    expect(applyPatch(text, p("@@ -2,1 +2,1 @@\n-TWO\n+2\n"))).toBeNull();
    expect(applyPatch(text, p("@@ -3,1 +3,1 @@\n-two\n+2\n"))).toBeNull();
  });
  it("keeps Windows line ends", () => {
    expect(applyPatch("a\r\nb\r\n", p("@@ -1,1 +1,1 @@\n-a\n+A\n"))).toBe("A\r\nb\r\n");
  });
  it("keeps every untouched line's own end in a file with mixed ends", () => {
    expect(applyPatch("a\r\nb\nc\r\n", p("@@ -2,1 +2,1 @@\n-b\n+B\n"))).toBe("a\r\nB\nc\r\n");
  });
  it("refuses a hunk cut short of its header's counts", () => {
    expect(applyPatch(text, p("@@ -2,2 +2,2 @@\n two\n"))).toBeNull();
  });
});

const cited = { file: "src/a.ts", start: 10, end: 12 };
const patch = (hunks: string, file = "src/a.ts") => `--- a/${file}\n+++ b/${file}\n${hunks}`;

describe("patchProblem", () => {
  it("accepts a change to the cited lines only", () => {
    expect(patchProblem(patch("@@ -9,4 +9,4 @@\n ctx\n-old 10\n+new 10\n line 11\n line 12\n"), cited)).toBeNull();
  });

  it("accepts a line added right before the first cited line or right after the last", () => {
    expect(patchProblem(patch("@@ -9,1 +9,2 @@\n line 9\n+added\n"), cited)).toBeNull();
    expect(patchProblem(patch("@@ -12,1 +12,2 @@\n line 12\n+added\n"), cited)).toBeNull();
  });

  it("refuses a removed line outside the cited lines", () => {
    expect(patchProblem(patch("@@ -12,2 +12,1 @@\n line 12\n-line 13\n"), cited)).toMatch(/removes line 13/);
  });

  it("refuses an added line outside the cited lines", () => {
    expect(patchProblem(patch("@@ -13,1 +13,2 @@\n line 13\n+added\n"), cited)).toMatch(/after line 13/);
    expect(patchProblem(patch("@@ -8,1 +8,2 @@\n line 8\n+added\n"), cited)).toMatch(/after line 8/);
  });

  it("refuses a patch to another file, or to two files", () => {
    expect(patchProblem(patch("@@ -10,1 +10,1 @@\n-a\n+b\n", "src/b.ts"), cited)).toMatch(/src\/b\.ts/);
    const two = `${patch("@@ -10,1 +10,1 @@\n-a\n+b\n")}${patch("@@ -1,1 +1,1 @@\n-a\n+b\n", "src/b.ts")}`;
    expect(patchProblem(two, cited)).toMatch(/not only/);
  });

  it("refuses a created or deleted file, and an empty patch", () => {
    expect(patchProblem("--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1,1 @@\n+x\n", cited)).toMatch(/creates or deletes/);
    expect(patchProblem("", cited)).toMatch(/no file/);
    expect(patchProblem(patch("@@ -10,1 +10,1 @@\n line 10\n"), cited)).toMatch(/no line/);
  });

  it("reads Windows line ends and the no-newline marker", () => {
    expect(patchProblem(patch("@@ -12,1 +12,1 @@\r\n-a\r\n\\ No newline at end of file\r\n+b\r\n"), cited)).toBeNull();
  });
});

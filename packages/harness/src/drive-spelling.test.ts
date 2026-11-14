import { describe, expect, it } from "vitest";
import { otherDriveSpelling, spellingProblem } from "./drive-spelling.ts";

describe("spellingProblem", () => {
  it("accepts the real spelling", () => {
    expect(spellingProblem("D:\\Projects\\x", "D:\\Projects\\x")).toBeUndefined();
    expect(spellingProblem("/home/x", "/home/x")).toBeUndefined();
  });

  it("leaves a junction or symlink to the checkout alone: it differs in more than case", () => {
    expect(spellingProblem("C:\\link\\x", "D:\\Projects\\x")).toBeUndefined();
  });

  it("names both spellings and what to run when the drive letter differs", () => {
    const problem = spellingProblem("d:\\Projects\\x", "D:\\Projects\\x");
    expect(problem).toContain('"d:\\Projects\\x"');
    expect(problem).toContain('"D:\\Projects\\x"');
    expect(problem).toContain("npm test");
  });
});

describe("otherDriveSpelling", () => {
  it("swaps the drive letter's case", () => {
    expect(otherDriveSpelling("D:\\Projects\\x")).toBe("d:\\Projects\\x");
    expect(otherDriveSpelling("d:/Projects/x")).toBe("D:/Projects/x");
  });

  it("leaves a path without a drive letter alone", () => {
    expect(otherDriveSpelling("/home/x")).toBeUndefined();
  });
});

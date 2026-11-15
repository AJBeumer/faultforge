import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { otherDriveSpelling, realSpelling, spellingProblem } from "./drive-spelling.ts";

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

describe("realSpelling (#316)", () => {
  it("gives the file system's spelling, drive letter included, for either spelling", () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-spelling-"));
    const real = realpathSync.native(dir);
    expect(realSpelling(dir)).toBe(real);
    expect(realSpelling(otherDriveSpelling(dir) ?? dir)).toBe(real);
  });

  it("returns a path that doesn't exist resolved, as written", () => {
    const missing = join(tmpdir(), "drive-spelling-no-such-folder", "x");
    expect(realSpelling(missing)).toBe(resolve(missing));
  });

  it("is how every script that takes --target reads it: none resolves it with plain resolve() (grep)", () => {
    const sources = readdirSync(import.meta.dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const plain = sources.filter((f) =>
      /\bresolve\((?:args\.|values\.|options\.)?target\)/.test(readFileSync(join(import.meta.dirname, f), "utf8")),
    );
    expect(plain).toEqual([]);
    const inject = readFileSync(join(import.meta.dirname, "inject-case.ts"), "utf8");
    expect(inject).toMatch(/const targetDir = realSpelling\(args\.target\)/);
  });
});

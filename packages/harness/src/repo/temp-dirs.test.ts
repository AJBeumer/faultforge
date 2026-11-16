/**
 * Temp folders in tests come from `fixtures/temp-dir.ts`, which names them by their real spelling. A test
 * that builds one itself from `tmpdir()` can compare a short Windows name with a long one and fail on that
 * system alone, where the agent that wrote it never ran it.
 *
 * `temp-dir-legacy.json` lists the test files that still call `tmpdir()` themselves. The list may only
 * shrink: a new test file must use the helper, and a file that stops calling `tmpdir()` leaves the list.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../fixtures/temp-dir.ts";
import { realSpelling } from "../shared/drive-spelling.ts";
import { ROOT } from "../shared/paths.ts";

const HARNESS = "packages/harness";
const LEGACY = join(ROOT, HARNESS, "src/repo/temp-dir-legacy.json");

/** The most files the list may hold: its length when the rule began. It is lowered as the list shrinks. */
const LEGACY_AT_MOST = 65;

/** Every test file under the harness that calls `tmpdir()` itself, relative to the repository, with `/`. */
function testFilesCallingTmpdir(): string[] {
  return (
    (readdirSync(join(ROOT, HARNESS), { recursive: true }) as string[])
      .map((file) => file.replace(/\\/g, "/"))
      .filter((file) => file.endsWith(".test.ts") && !file.includes("node_modules/"))
      // This file names the call in its own words, and uses the helper.
      .filter((file) => file !== "src/repo/temp-dirs.test.ts")
      .filter((file) => /\btmpdir\(\)/.test(readFileSync(join(ROOT, HARNESS, file), "utf8")))
      .map((file) => `${HARNESS}/${file}`)
      .sort()
  );
}

describe("temp folders in tests", () => {
  const legacy: string[] = JSON.parse(readFileSync(LEGACY, "utf8"));
  const found = testFilesCallingTmpdir();

  it("no new test file builds a temp path from tmpdir() itself: use fixtures/temp-dir.ts", () => {
    expect(found.filter((file) => !legacy.includes(file))).toEqual([]);
  });

  it("the list of files that still do only shrinks: a file that stopped is taken off it", () => {
    expect(legacy.filter((file) => !found.includes(file))).toEqual([]);
    expect([...legacy].sort()).toEqual(legacy);
    expect(new Set(legacy).size).toBe(legacy.length);
  });

  it("the list never grows: it holds no more files than the number written here", () => {
    // Lower this number whenever the list gets shorter. Adding a file to the list fails here.
    expect(legacy.length).toBeLessThanOrEqual(LEGACY_AT_MOST);
  });

  it("the helper gives a folder that exists and is already spelled the way the system spells it", () => {
    const dir = tempDir("temp-dirs-test-");
    expect(realSpelling(dir)).toBe(dir);
    expect(readdirSync(dir)).toEqual([]);
  });
});

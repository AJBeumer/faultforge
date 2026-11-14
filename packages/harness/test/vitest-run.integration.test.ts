/**
 * The launcher behind `npm test` (`vitest-run.ts`), run as a real process. It gives the same result whichever
 * case the drive letter was typed in (AUD-M25, #253), and a direct `vitest` from the other spelling stops with a
 * message that says what to run instead; those two are Windows only, since elsewhere a path has no drive letter.
 * Each run starts a real Vitest on one small test file.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { otherDriveSpelling } from "../src/drive-spelling.ts";

const root = resolve(import.meta.dirname, "../../..");
const other = otherDriveSpelling(root);
const testFile = "packages/harness/src/drive-spelling.test.ts";

// Colour off, and any colour codes stripped anyway: CI forces colour, which splits "Tests  5 passed" with codes.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const run = (cwd: string, args: string[]) => {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  return { status: result.status, stdout: result.stdout.replace(ANSI, ""), stderr: result.stderr.replace(ANSI, "") };
};

describe.runIf(process.platform === "win32" && other)("both drive spellings", () => {
  const spellings = [root, other as string];

  it.each(spellings)(
    "the launcher passes from %s",
    (cwd) => {
      const result = run(cwd, [join(root, "packages/harness/src/vitest-run.ts"), "run", "--project", "unit", testFile]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toMatch(/Tests\s+\d+ passed/);
      // A cold Vitest start on a Windows runner can take longer than the 5 s default (Qodo on PR 260).
    },
    120_000,
  );

  it("a direct Vitest from the spelling that isn't real says to use npm test", () => {
    // `root` is the real spelling (the launcher starts Vitest there), so `other` is the one that isn't.
    const result = run(other as string, [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--project",
      "unit",
      testFile,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("npm test");
  }, 120_000);
});

describe("the launcher's exit codes", () => {
  it("exits 2, not a test failure's 1, when it can't start Vitest", () => {
    const empty = mkdtempSync(join(tmpdir(), "vitest-run-"));
    try {
      const result = run(empty, [join(root, "packages/harness/src/vitest-run.ts"), "run"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("could not start Vitest");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

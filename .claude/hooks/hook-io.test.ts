import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOW, type Decision, hookAnswer, isEntry } from "./hook-io.ts";

describe("isEntry: a hook knows when it is the file being run", () => {
  const here = fileURLToPath(import.meta.url);

  it("is true for the file node was started with", () => {
    expect(isEntry(import.meta.url, here)).toBe(true);
  });

  it("is false for another file, and when there is no entry at all", () => {
    expect(isEntry(import.meta.url, here.replace(/hook-io\.test\.ts$/, "fixtures.ts"))).toBe(false);
    expect(isEntry(import.meta.url, undefined)).toBe(false);
  });

  it("is false for a file that doesn't exist, compared as spelled", () => {
    expect(isEntry(import.meta.url, here.replace(/hook-io\.test\.ts$/, "no-such-hook.ts"))).toBe(false);
  });

  // A hook that took itself for an import would stay silent, and silence is a bypass. On Windows the
  // project folder can reach the hook with its drive letter in either case.
  it.runIf(process.platform === "win32")("is true when the entry's drive letter is spelled in another case", () => {
    const letter = here.charAt(0);
    const swapped = (letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase()) + here.slice(1);
    expect(swapped).not.toBe(here);
    expect(isEntry(import.meta.url, swapped)).toBe(true);
  });
});

describe("hookAnswer: a payload that can't be read is the hook's own failure (Qodo on PR 131)", () => {
  const failed = (error: unknown): Decision => ({ kind: "error", message: `hook failed: ${String(error)}` });

  it("passes what was read to the decision", () => {
    expect(
      hookAnswer(
        () => "{}",
        (stdin) => ({ kind: "deny", reason: stdin }),
        failed,
      ),
    ).toEqual({
      kind: "deny",
      reason: "{}",
    });
  });

  it("turns a failing read into the blocking error, never a crash", () => {
    const read = () => {
      throw new Error("EBADF: bad file descriptor, read");
    };
    expect(hookAnswer(read, () => ALLOW, failed)).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/EBADF/),
    });
  });
});

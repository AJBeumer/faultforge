import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isEntry } from "./hook-io.ts";

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

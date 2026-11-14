/**
 * The giveaway word list against the reviewed target as it really is (#306): every tracked file, every commit
 * message on its history and every branch name must read as ordinary text. A word added to `neutral.ts` that
 * flags ordinary engineering text fails here. Needs the target checked out next to this repository, as on the
 * owner's machine and in CI's integration job.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { telltales } from "../src/neutral.ts";

const TARGET = join(import.meta.dirname, "../../../../faultforge-target");
const git = (...args: string[]) =>
  execFileSync("git", ["-C", TARGET, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

describe.skipIf(!existsSync(join(TARGET, ".git")))("the word list on the target's real text", () => {
  it("finds nothing in any tracked file", () => {
    const files = git("ls-files", "-z").split("\0").filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    const flagged = files.flatMap((file) => {
      const found = telltales(readFileSync(join(TARGET, file), "utf8"));
      return found.length ? [`${file}: ${found.join(", ")}`] : [];
    });
    expect(flagged).toEqual([]);
  });

  it("finds nothing in any commit message or branch name", () => {
    const messages = git("log", "--all", "--format=%H%n%B%x00")
      .split("\0")
      .filter((m) => m.trim());
    expect(messages.length).toBeGreaterThan(0);
    const flagged = messages.flatMap((message) => {
      const found = telltales(message);
      return found.length ? [`${message.trim().slice(0, 12)}: ${found.join(", ")}`] : [];
    });
    expect(flagged).toEqual([]);
    const branches = git("for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes").split("\n");
    expect(branches.filter((branch) => telltales(branch).length)).toEqual([]);
  });
});

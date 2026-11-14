import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eachGitLine, gitDirOf } from "./git-stream.ts";

describe("eachGitLine (AUD-N6, Qodo on PR 280)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-stream-test-"));
    execFileSync("git", ["init", "-q", dir]);
    writeFileSync(join(dir, "f.txt"), `${"é".repeat(700_000)}\nsecond\n`);
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "one"]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("hands back every line, whole, across chunk boundaries and multi-byte characters", () => {
    const lines: string[] = [];
    eachGitLine(dir, ["show", "HEAD:f.txt"], (line) => lines.push(line));
    expect(lines).toEqual(["é".repeat(700_000), "second"]);
  });

  it("keeps its temporary file inside the repository's git folder, and removes it", () => {
    const gitDir = gitDirOf(dir);
    const during: string[] = [];
    eachGitLine(dir, ["show", "HEAD:f.txt"], () => {
      if (!during.length) during.push(...readdirSync(gitDir).filter((n) => n.startsWith("line-stream-")));
    });
    expect(during).toHaveLength(1);
    expect(readdirSync(gitDir).filter((n) => n.startsWith("line-stream-"))).toEqual([]);
  });

  it("removes what a killed run left behind once it is an hour old, and leaves a fresh one alone", () => {
    const gitDir = gitDirOf(dir);
    const stale = join(gitDir, "line-stream-old");
    const fresh = join(gitDir, "line-stream-new");
    mkdirSync(stale);
    mkdirSync(fresh);
    const now = Date.now();
    const hourAndMore = new Date(now - 2 * 60 * 60 * 1000);
    utimesSync(stale, hourAndMore, hourAndMore);
    eachGitLine(dir, ["rev-parse", "HEAD"], () => {}, now);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("throws with git's own message when git fails", () => {
    expect(() => eachGitLine(dir, ["show", "HEAD:nope.txt"], () => {})).toThrow(/git show exited/);
  });
});

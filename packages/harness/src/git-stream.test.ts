import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eachGitLine, TEMP_PREFIX } from "./git-stream.ts";

/** Every file and folder under `root`, as relative paths, so a test can see that nothing was added. */
function listing(root: string): string[] {
  return readdirSync(root, { recursive: true }).map(String).sort();
}

describe("eachGitLine (AUD-N6, Qodo on PR 280)", () => {
  let dir: string;
  let temp: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "git-stream-test-"));
    temp = mkdtempSync(join(tmpdir(), "git-stream-temp-"));
    execFileSync("git", ["init", "-q", dir]);
    writeFileSync(join(dir, "f.txt"), `${"é".repeat(700_000)}\nsecond\n`);
    execFileSync("git", ["-C", dir, "add", "f.txt"]);
    execFileSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "one"]);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  });

  it("hands back every line, whole, across chunk boundaries and multi-byte characters", () => {
    const lines: string[] = [];
    eachGitLine(dir, ["show", "HEAD:f.txt"], (line) => lines.push(line), Date.now(), temp);
    expect(lines).toEqual(["é".repeat(700_000), "second"]);
  });

  it("writes nothing inside the repository it reads, not even in its git folder", () => {
    const before = listing(dir);
    let duringRepo: string[] = [];
    eachGitLine(dir, ["show", "HEAD:f.txt"], () => {
      if (!duringRepo.length) duringRepo = listing(dir);
    });
    expect(duringRepo).toEqual(before);
    expect(listing(dir)).toEqual(before);
  });

  it("keeps its temporary file in a private folder of its own outside the repository, and removes it", () => {
    const during: { name: string; mode: number }[] = [];
    eachGitLine(
      dir,
      ["show", "HEAD:f.txt"],
      () => {
        if (during.length) return;
        for (const name of readdirSync(temp).filter((n) => n.startsWith(TEMP_PREFIX)))
          during.push({ name, mode: statSync(join(temp, name)).mode & 0o777 });
      },
      Date.now(),
      temp,
    );
    expect(during).toHaveLength(1);
    // Windows has no POSIX modes; everywhere else only this user may read the folder.
    if (process.platform !== "win32") expect(during[0]?.mode).toBe(0o700);
    expect(readdirSync(temp).filter((n) => n.startsWith(TEMP_PREFIX))).toEqual([]);
  });

  it("removes its folder when git fails too", () => {
    expect(() => eachGitLine(dir, ["show", "HEAD:nope.txt"], () => {}, Date.now(), temp)).toThrow(/git show exited/);
    expect(readdirSync(temp)).toEqual([]);
  });

  it("removes what a killed run left behind once it is an hour old, and leaves a fresh one alone", () => {
    const stale = join(temp, `${TEMP_PREFIX}old`);
    const fresh = join(temp, `${TEMP_PREFIX}new`);
    mkdirSync(stale);
    mkdirSync(fresh);
    const now = Date.now();
    const hourAndMore = new Date(now - 2 * 60 * 60 * 1000);
    utimesSync(stale, hourAndMore, hourAndMore);
    eachGitLine(dir, ["rev-parse", "HEAD"], () => {}, now, temp);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

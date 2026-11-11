import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BranchExistence, deriveBranchName, gitBranchExistence } from "./branch-name.ts";
import { telltales } from "./neutral.ts";

function fakeGit(local: string[], origin: string[]): BranchExistence {
  return {
    existsLocally: (name) => local.includes(name),
    existsOnOrigin: (name) => origin.includes(name),
  };
}

describe("deriveBranchName", () => {
  it("uses the base name on a first run, when nothing takes it", () => {
    expect(deriveBranchName("tidy-replay-lookup", fakeGit([], []))).toBe("tidy-replay-lookup");
  });

  it("falls back to -2 when the base name is taken locally", () => {
    expect(deriveBranchName("tidy-replay-lookup", fakeGit(["tidy-replay-lookup"], []))).toBe("tidy-replay-lookup-2");
  });

  it("falls back to -3 when the base name and -2 are both taken on origin", () => {
    expect(deriveBranchName("tidy-replay-lookup", fakeGit([], ["tidy-replay-lookup", "tidy-replay-lookup-2"]))).toBe(
      "tidy-replay-lookup-3",
    );
  });

  it("treats a name as taken whichever of local or origin holds it", () => {
    expect(deriveBranchName("tidy-replay-lookup", fakeGit(["tidy-replay-lookup-2"], ["tidy-replay-lookup"]))).toBe(
      "tidy-replay-lookup-3",
    );
  });

  it("never reuses a branch that only exists on origin, pushed from another checkout", () => {
    expect(deriveBranchName("tidy-replay-lookup", fakeGit([], ["tidy-replay-lookup"]))).toBe("tidy-replay-lookup-2");
  });

  it("a numeric suffix never introduces a giveaway the base name didn't already have", () => {
    const bases = ["tidy-replay-lookup", "quiet-booking-sweep", "steady-queue-rename"];
    for (const base of bases) {
      expect(telltales(base)).toEqual([]);
      for (let suffix = 2; suffix < 50; suffix++) {
        expect(telltales(`${base}-${suffix}`)).toEqual([]);
      }
    }
  });
});

// A throwaway repo and, where needed, a throwaway bare "origin" for it, all on local disk: no network.
function git(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "branch-existence-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.org");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "commit", "-q", "--allow-empty", "-m", "initial");
  return dir;
}

describe("gitBranchExistence", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  function makeScratchRepo(): string {
    const dir = scratchRepo();
    dirs.push(dir);
    return dir;
  }

  it("existsLocally is true only for a branch that actually exists locally", () => {
    const dir = makeScratchRepo();
    git(dir, "branch", "topic");
    const existence = gitBranchExistence(dir);
    expect(existence.existsLocally("topic")).toBe(true);
    expect(existence.existsLocally("absent")).toBe(false);
  });

  it("existsOnOrigin is true for a branch pushed to origin, and false once confirmed absent", () => {
    const bare = mkdtempSync(join(tmpdir(), "branch-existence-bare-"));
    dirs.push(bare);
    git(bare, "init", "-q", "--bare");
    const dir = makeScratchRepo();
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "origin", "main:refs/heads/taken-branch");
    const existence = gitBranchExistence(dir);
    expect(existence.existsOnOrigin("taken-branch")).toBe(true);
    expect(existence.existsOnOrigin("never-pushed")).toBe(false);
  });

  it("existsOnOrigin throws, rather than assuming the branch is free, when origin can't be reached", () => {
    const dir = makeScratchRepo();
    git(dir, "remote", "add", "origin", join(dir, "no-such-remote"));
    expect(() => gitBranchExistence(dir).existsOnOrigin("anything")).toThrow(/ls-remote/);
  });
});

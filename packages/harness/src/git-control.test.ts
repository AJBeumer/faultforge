import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GIT_CONTROL, gitControlPrint, gitControlProblem } from "./git-control.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-control-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "start",
  ]);
  return dir;
}

describe("the git hooks and config of a checkout the agent could write (#335)", () => {
  it("changes when a hook is added or changed, or the config changes", () => {
    const dir = repo();
    const first = gitControlPrint(dir);
    expect(gitControlPrint(dir)).toBe(first);
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho hi\n");
    const hooked = gitControlPrint(dir);
    expect(hooked).not.toBe(first);
    writeFileSync(join(dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho bye\n");
    expect(gitControlPrint(dir)).not.toBe(hooked);
    const before = gitControlPrint(dir);
    appendFileSync(join(dir, ".git", "config"), "[core]\n\tfsmonitor = ./x\n");
    expect(gitControlPrint(dir)).not.toBe(before);
  });

  it("reads a worktree's shared hooks and config, and its own config.worktree", () => {
    const main = repo();
    const tree = join(mkdtempSync(join(tmpdir(), "git-control-wt-")), "w");
    execFileSync("git", ["-C", main, "worktree", "add", "-q", "--detach", tree]);
    const first = gitControlPrint(tree);
    mkdirSync(join(main, ".git", "hooks"), { recursive: true });
    writeFileSync(join(main, ".git", "hooks", "post-commit"), "#!/bin/sh\n");
    const shared = gitControlPrint(tree);
    expect(shared).not.toBe(first);
    writeFileSync(join(main, ".git", "worktrees", "w", "config.worktree"), "[core]\n\thooksPath = /tmp\n");
    expect(gitControlPrint(tree)).not.toBe(shared);
  });

  it("names the change, and lets an unchanged checkout through", () => {
    const dir = repo();
    const prints = { [GIT_CONTROL(dir)]: gitControlPrint(dir) };
    expect(gitControlProblem(dir, prints)).toBeUndefined();
    writeFileSync(join(dir, ".git", "hooks", "pre-push"), "#!/bin/sh\n");
    expect(gitControlProblem(dir, prints)).toMatch(/hooks or config changed/);
    // No print taken before the agent: nothing to compare with, so it isn't trusted either.
    expect(gitControlProblem(dir, {})).toMatch(/no print/);
  });
});

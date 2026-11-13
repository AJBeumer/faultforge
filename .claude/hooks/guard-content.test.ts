import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canSymlink, tempRepo } from "./fixtures.ts";
import { chainProblem, pendingCommit, pendingIndex, pendingPush, Uninspectable } from "./guard-content.ts";

describe("chainProblem: the steps a git chain may contain inside a reviewed checkout", () => {
  it.each([
    "git add -A && git commit -F msg.txt && git push -u origin HEAD",
    "cd ../app && git add . && git commit -m Tidy",
    "git -C ../app add -A && git -C ../app commit -m Tidy",
    'git -C "D:\\Projects\\app" add -A && git -C "D:\\Projects\\app" commit -m Tidy',
    "git --work-tree=../app status && git --work-tree=../app commit -m Tidy",
    "git status 2>&1 && git commit -m Tidy",
    "npm run check > /dev/null && git commit -m Tidy",
    "echo <<'EOF'\n$(not run: the delimiter is quoted)\nEOF\ngit add . && git commit -m Tidy",
    "echo <<EOF\nliteral \\$(not run: escaped) and \\`neither\\`\nEOF\ngit add . && git commit -m Tidy",
  ])("allows %s", (command) => {
    expect(chainProblem(command)).toBeUndefined();
  });

  it.each([
    ["a copy", "cp hint.md . && git add . && git commit -m Tidy", /^cp /],
    ["a shell function", 'f(){ git "$@"; }; f commit -m Tidy', /^f\(\)/],
    ["a redirect", "echo x > notes.md; git add . && git commit -m Tidy", />/],
    ["a numbered redirect (Qodo, round 3)", 'echo "$PAYLOAD" 1>notes.md && git add . && git commit -m Tidy', /1>/],
    ["an appending numbered redirect", "echo x 2>>err.log && git commit -m Tidy", /2>>/],
    [
      "a heredoc body that expands (Qodo, round 3)",
      "echo <<EOF\n$(echo planted > n.md)\nEOF\ngit add . && git commit -m Tidy",
      /heredoc/,
    ],
    ["a script", "node write.js && git add . && git commit -m Tidy", /^node/],
    [
      "git stash pop, which writes files from outside the committed history",
      "git stash pop && git commit -m Tidy",
      /stash/,
    ],
    [
      "a command substitution inside an allowed step (Qodo, round 4)",
      "git -C ../app status $(cp /tmp/payload ../app/notes.md) && git -C ../app add . && git -C ../app commit -m Tidy",
      /\$\(/,
    ],
    ["a backtick substitution inside an allowed step", "git status `cp a b` && git commit -m Tidy", /`/],
    [
      "an escaped backslash before a real substitution in a heredoc body (Qodo, round 5)",
      "echo <<EOF\nliteral \\\\$(cp /tmp/payload ../app/notes.md)\nEOF\ngit add . && git commit -m Tidy",
      /heredoc/,
    ],
  ])("refuses %s", (_name, command, step) => {
    expect(chainProblem(command)).toMatch(step);
  });
});

describe("pendingCommit: what a commit would take", () => {
  it("reads a file that was staged and then deleted from the working tree (Qodo, round 3)", () => {
    const { dir, git } = tempRepo();
    writeFileSync(join(dir, "notes.md"), "The planted bug\n");
    git("add", "notes.md");
    rmSync(join(dir, "notes.md"));
    expect(pendingCommit(dir, false).reasons).toContain("says planted");
  });

  it.skipIf(!canSymlink())("reads a symlink's target text, which is what git commits (Qodo, round 3)", () => {
    const { dir } = tempRepo();
    symlinkSync("planted-target", join(dir, "link"));
    expect(pendingCommit(dir, false).reasons).toContain("says planted");
  });

  it("tolerates a dangling untracked path instead of refusing every commit", () => {
    const { dir } = tempRepo();
    writeFileSync(join(dir, "ok.md"), "fine\n");
    expect(pendingCommit(dir, false).reasons).toEqual([]);
  });
});

describe("pendingPush: what a push would take", () => {
  it("scans a merge commit's own changes, made while resolving (Qodo, round 3)", () => {
    const { dir, git } = tempRepo(true);
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "feature.md"), "fine\n");
    git("add", "feature.md");
    git("commit", "-q", "-m", "Feature");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "--no-commit", "feature");
    writeFileSync(join(dir, "resolved.md"), "The planted bug\n"); // introduced only in the merge commit
    git("add", "resolved.md");
    git("commit", "-q", "-m", "Merge feature");
    const pending = pendingPush(dir);
    expect(pending.reasons).toContain("says planted");
    expect(pending.where).toMatch(/2 commits/);
  });

  it("gives up, as a failure to inspect, when the scan would outlast its budget (Qodo, round 3)", () => {
    const { dir, git } = tempRepo(true);
    writeFileSync(join(dir, "a.md"), "fine\n");
    git("add", "a.md");
    git("commit", "-q", "-m", "A");
    expect(() => pendingPush(dir, -1)).toThrow(Uninspectable);
    expect(() => pendingPush(dir, -1)).toThrow(/longer than/);
  });

  it("reads every file of every unpushed commit in one git process per commit, binary included", () => {
    const { dir, git } = tempRepo(true);
    writeFileSync(
      join(dir, "img.bin"),
      Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from("planted"), Buffer.from([0])]),
    );
    git("add", "img.bin");
    git("commit", "-q", "-m", "Add image");
    expect(pendingPush(dir).reasons).toContain("says planted");
    git("reset", "-q", "--hard", "origin/main");
    expect(pendingPush(dir).reasons).toEqual([]);
  });
});

describe("pendingIndex: what the next commit records (#191)", () => {
  it("reads a staged submodule entry by its name only, not as file content (Qodo on PR 213)", () => {
    const { git } = tempRepo();
    // A gitlink to a commit this repository doesn't have: reading it as a file would fail.
    git("update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},vendor/lib`);
    expect(pendingIndex(git("rev-parse", "--show-toplevel").trim())).toEqual({
      reasons: [],
      where: "the staged changes",
    });
  });
});

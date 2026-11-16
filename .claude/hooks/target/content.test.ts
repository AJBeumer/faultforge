import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canSymlink, tempRepo } from "../fixtures.ts";
import { pendingCommit, pendingIndex, pendingPush, Uninspectable, withDeadline } from "./content.ts";

describe("pendingCommit: what a commit would take", () => {
  it("reads a file that was staged and then deleted from the working tree", () => {
    const { dir, git } = tempRepo();
    writeFileSync(join(dir, "notes.md"), "The planted bug\n");
    git("add", "notes.md");
    rmSync(join(dir, "notes.md"));
    expect(pendingCommit(dir, false).reasons).toContain("says planted");
  });

  it.skipIf(!canSymlink())("reads a symlink's target text, which is what git commits", () => {
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
  it("scans a merge commit's own changes, made while resolving", () => {
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

  it("gives up, as a failure to inspect, when the scan would outlast its budget", () => {
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

describe("pendingIndex: what the next commit records", () => {
  it("reads a staged submodule entry by its name only, not as file content", () => {
    const { git } = tempRepo();
    // A gitlink to a commit this repository doesn't have: reading it as a file would fail.
    git("update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},vendor/lib`);
    expect(pendingIndex(git("rev-parse", "--show-toplevel").trim())).toEqual({
      reasons: [],
      where: "the staged changes",
    });
  });
});

describe("withDeadline: one deadline for a whole decision", () => {
  it("makes every scan inside it share one deadline, and a spent one a failure to inspect", () => {
    const { dir } = tempRepo();
    expect(() => withDeadline(-1, () => pendingCommit(dir, false))).toThrow(Uninspectable);
    expect(() => withDeadline(-1, () => pendingPush(dir))).toThrow(/ran out/);
    expect(withDeadline(8000, () => pendingCommit(dir, false)).reasons).toEqual([]);
    // Outside any deadline.
    expect(pendingCommit(dir, false).reasons).toEqual([]);
  });
});

describe("withDeadline: a decision that finished late", () => {
  it("refuses work that ran past the deadline even when no git call came after it", () => {
    const slow = () => {
      const until = Date.now() + 30;
      while (Date.now() < until) {
        // a long scan of posted text, with no git call to notice the time
      }
      return "allow";
    };
    expect(() => withDeadline(5, slow)).toThrow(/ran out before it finished/);
    expect(withDeadline(5000, slow)).toBe("allow");
  });
});

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLocalDiff,
  countDiffHeaders,
  parseGitStatusZ,
  readWorkingTreeSplit,
  splitDiffSections,
  streamId,
} from "./local-diff.ts";

/** NUL-terminated entries, as `git status --porcelain -z` prints them. */
const z = (...entries: string[]) => entries.map((e) => `${e}\0`).join("");

describe("parseGitStatusZ", () => {
  it("splits staged, unstaged and untracked paths from git status --porcelain -z", () => {
    const porcelain = z("M  staged.txt", " M unstaged.txt", "?? untracked.txt", "MM both.txt", "D  removed.txt");
    expect(parseGitStatusZ(porcelain)).toEqual({
      staged: ["staged.txt", "both.txt", "removed.txt"],
      unstaged: ["unstaged.txt", "both.txt"],
      untracked: ["untracked.txt"],
    });
  });

  it("takes a rename's new path and skips the old one, which -z prints as its own entry", () => {
    expect(parseGitStatusZ(z("R  new.txt", "old.txt", "?? other.txt"))).toEqual({
      staged: ["new.txt"],
      unstaged: [],
      untracked: ["other.txt"],
    });
  });

  it("reads names as written: spaces, quotes and arrows are part of the name", () => {
    expect(parseGitStatusZ(z('?? my "notes".txt', "?? old.txt -> new.txt"))).toEqual({
      staged: [],
      unstaged: [],
      untracked: ['my "notes".txt', "old.txt -> new.txt"],
    });
  });

  it("is empty for a clean tree", () => {
    expect(parseGitStatusZ("")).toEqual({ staged: [], unstaged: [], untracked: [] });
  });
});

describe("splitDiffSections", () => {
  it("splits a multi-file diff at each file's own header", () => {
    const diff =
      "diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-a\n+b\n" +
      "diff --git a/two.txt b/two.txt\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-c\n+d\n";
    const sections = splitDiffSections(diff);
    expect(sections.map((s) => s.file)).toEqual(["one.txt", "two.txt"]);
    expect(sections[0]?.body).toContain("-a\n+b");
    expect(sections[1]?.body).toContain("-c\n+d");
  });

  it("is empty for an empty diff", () => {
    expect(splitDiffSections("")).toEqual([]);
  });
});

describe("countDiffHeaders", () => {
  it("counts every header line, quoted or not, so a quoted one after a plain one still shows", () => {
    const text = [
      "diff --git a/one.txt b/one.txt",
      "+x",
      'diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"',
      "+y",
      "",
    ].join("\n");
    expect(countDiffHeaders(text)).toBe(2);
    expect(splitDiffSections(text)).toHaveLength(1);
  });

  it("is zero for an empty diff", () => {
    expect(countDiffHeaders("")).toBe(0);
  });
});

describe("streamId", () => {
  it("is the same hash for the same worktree path", () => {
    expect(streamId("/repo/a")).toBe(streamId("/repo/a"));
    expect(streamId("/repo/a")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("differs for different worktree paths", () => {
    expect(streamId("/repo/a")).not.toBe(streamId("/repo/b"));
  });
});

describe("buildLocalDiff on a real git repository", () => {
  let root: string;
  const sh = (repo: string, ...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  // Untrimmed, like production: a trimmed first line loses its leading status space.
  const status = (repo: string, ...extra: string[]) =>
    execFileSync("git", ["-C", repo, "status", "--porcelain", ...extra], { encoding: "utf8" });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function initRepo() {
    root = mkdtempSync(join(tmpdir(), "local-diff-test-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "config", "user.email", "t@example.com");
    sh(repo, "config", "user.name", "t");
    return repo;
  }

  it("combines tracked (staged + unstaged) and untracked changes into one diff", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "tracked.txt"), "line1\nline2\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "base");
    const base = sh(repo, "rev-parse", "HEAD");

    writeFileSync(join(repo, "tracked.txt"), "line1\nline2 staged\n");
    sh(repo, "add", "tracked.txt");
    writeFileSync(join(repo, "tracked.txt"), "line1\nline2 staged\nline3 unstaged\n");
    writeFileSync(join(repo, "new-file.txt"), "hello\nworld\n");

    const split = readWorkingTreeSplit(repo);
    const result = buildLocalDiff(repo, base, split);

    expect(result.complete).toBe(true);
    expect(result.excludedFiles).toEqual([]);
    expect(result.diff).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.diff).toContain("line3 unstaged");
    expect(result.diff).toContain("diff --git a/new-file.txt b/new-file.txt");
    expect(result.diff).toContain("new file mode");
    expect(result.diff).toContain("+hello");
  });

  it("is empty, and complete, on a clean tree", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "f.txt"), "x\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "base");
    const base = sh(repo, "rev-parse", "HEAD");

    const result = buildLocalDiff(repo, base, { staged: [], unstaged: [], untracked: [] });
    expect(result).toEqual({
      diff: "",
      excludedFiles: [],
      skippedFiles: [],
      noNetChangeFiles: [],
      complete: true,
    });
  });

  it("excludes a binary file instead of submitting its content-free summary as reviewed", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "tracked.txt"), "line1\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "base");
    const base = sh(repo, "rev-parse", "HEAD");

    writeFileSync(join(repo, "tracked.txt"), "line1\nline2\n");
    writeFileSync(join(repo, "image.bin"), Buffer.from([0, 1, 2, 0, 3, 4]));

    const split = readWorkingTreeSplit(repo);
    const result = buildLocalDiff(repo, base, split);

    expect(result.complete).toBe(false);
    expect(result.excludedFiles).toEqual(["image.bin"]);
    expect(result.skippedFiles[0]).toMatchObject({ file: "image.bin" });
    expect(result.diff).not.toContain("image.bin");
    expect(result.diff).toContain("diff --git a/tracked.txt b/tracked.txt");
  });

  it("produces a diff `git apply` accepts cleanly against the base commit (Qodo rejected a truncated one live, 12 November)", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "tracked.txt"), "line1\nline2\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "base");
    const base = sh(repo, "rev-parse", "HEAD");

    writeFileSync(join(repo, "tracked.txt"), "line1\nline2 modified\n");
    writeFileSync(join(repo, "first-untracked.txt"), "a\nb\n");
    // The file whose diff lands last matters most: an earlier bug dropped its trailing newline.
    writeFileSync(join(repo, "last-untracked.txt"), "c\nd\n");

    const split = readWorkingTreeSplit(repo);
    const result = buildLocalDiff(repo, base, split);
    expect(result.complete).toBe(true);

    const clean = join(root, "clean-checkout");
    sh(root, "clone", "-q", repo, clean);
    sh(clean, "checkout", "-q", base);
    const patchPath = join(root, "local.diff");
    writeFileSync(patchPath, result.diff);
    expect(() => sh(clean, "apply", "--check", patchPath)).not.toThrow();
  });

  it("lists a new directory's files individually with --untracked-files=all, not as one entry (a real gap, 12 November)", () => {
    const repo = initRepo();
    sh(repo, "commit", "-qm", "base", "--allow-empty");
    mkdirSync(join(repo, "newdir"), { recursive: true });
    writeFileSync(join(repo, "newdir", "a.txt"), "a\n");
    writeFileSync(join(repo, "newdir", "b.txt"), "b\n");

    const defaultSplit = parseGitStatusZ(status(repo, "-z"));
    expect(defaultSplit.untracked).toEqual(["newdir/"]);

    const allSplit = parseGitStatusZ(status(repo, "-z", "--untracked-files=all"));
    expect(allSplit.untracked.sort()).toEqual(["newdir/a.txt", "newdir/b.txt"]);

    const base = sh(repo, "rev-parse", "HEAD");
    const result = buildLocalDiff(repo, base, allSplit);
    expect(result.complete).toBe(true);
    expect(result.diff).toContain("diff --git a/newdir/a.txt b/newdir/a.txt");
    expect(result.diff).toContain("diff --git a/newdir/b.txt b/newdir/b.txt");
  });

  // A double quote forces git to quote the whole header, which splitDiffSections's plain a/…/b/…
  // pattern never matches (confirmed live, 12 November) — but Windows itself refuses that character
  // in a filename, so the scenario can only be built, and so only matters, on Linux and macOS.
  it.skipIf(process.platform === "win32")(
    "flags a tracked file whose diff header git had to quote, instead of silently dropping it",
    () => {
      const repo = initRepo();
      sh(repo, "commit", "-qm", "base", "--allow-empty");
      writeFileSync(join(repo, 'weird"name.txt'), "x\n");
      sh(repo, "add", ".");
      const base = sh(repo, "rev-parse", "HEAD");

      const result = buildLocalDiff(repo, base, { staged: [], unstaged: [], untracked: [] });
      expect(result.complete).toBe(false);
      expect(result.excludedFiles).toContain("(unrecognized diff header)");
      expect(result.diff).toBe("");
    },
  );

  // An external diff helper that prints nothing hides every changed file from `git diff`'s text, while
  // git itself still knows they differ from the base. `true` exists only on POSIX shells.
  it.skipIf(process.platform === "win32")(
    "flags a changed file that git's diff leaves out, never calling the snapshot complete",
    () => {
      const repo = initRepo();
      writeFileSync(join(repo, "a.txt"), "1\n");
      sh(repo, "add", ".");
      sh(repo, "commit", "-qm", "base");
      const base = sh(repo, "rev-parse", "HEAD");
      writeFileSync(join(repo, "a.txt"), "1\n2\n");
      sh(repo, "config", "diff.external", "true");

      const result = buildLocalDiff(repo, base, readWorkingTreeSplit(repo));
      expect(result.complete).toBe(false);
      expect(result.excludedFiles).toEqual(["a.txt"]);
      expect(result.noNetChangeFiles).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")("flags a quoted header that comes after a plain one", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "1\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "base");
    const base = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.txt"), "1\n2\n");
    writeFileSync(join(repo, 'z"q.txt'), "x\n");
    sh(repo, "add", ".");

    const result = buildLocalDiff(repo, base, { staged: [], unstaged: [], untracked: [] });
    expect(result.complete).toBe(false);
    expect(result.excludedFiles).toContain("(unrecognized diff header)");
  });

  it("keeps a non-ASCII filename complete: status and diff spell it the same", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "café.txt"), "1\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "base");
    const base = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "café.txt"), "1\n2\n");

    const split = readWorkingTreeSplit(repo);
    expect(split.unstaged).toEqual(["café.txt"]);
    const result = buildLocalDiff(repo, base, split);
    expect(result.complete).toBe(true);
    expect(result.skippedFiles).toEqual([]);
  });

  it("does not throw on a patch larger than a default child-process buffer", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "big.txt"), "start\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "base");
    const base = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "big.txt"), `${"x".repeat(79)}${"\n"}`.repeat(30_000));

    const result = buildLocalDiff(repo, base, readWorkingTreeSplit(repo));
    expect(result.complete).toBe(true);
    expect(result.diff.length).toBeGreaterThan(2_000_000);
  });

  it("sends an untracked file whose name has a space, and calls the snapshot complete only then (#189)", () => {
    const repo = initRepo();
    sh(repo, "commit", "-qm", "base", "--allow-empty");
    const base = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "my notes.txt"), "a note\n");
    writeFileSync(join(repo, "plain.txt"), "plain\n");

    const split = readWorkingTreeSplit(repo);
    expect(split.untracked.sort()).toEqual(["my notes.txt", "plain.txt"]);
    const result = buildLocalDiff(repo, base, split);
    expect(result.diff).toContain("my notes.txt");
    expect(result.diff).toContain("plain.txt");
    expect(result.excludedFiles).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("diffs a tracked file whose name has a space, never calling it unchanged (#189)", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "tracked file.txt"), "1\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "base");
    const base = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "tracked file.txt"), "2\n");

    const result = buildLocalDiff(repo, base, readWorkingTreeSplit(repo));
    expect(result.noNetChangeFiles).toEqual([]);
    expect(result.diff).toContain("tracked file.txt");
    expect(result.complete).toBe(true);
  });

  it("lists an untracked file git can't open as excluded, and the snapshot as incomplete (#189)", () => {
    const repo = initRepo();
    sh(repo, "commit", "-qm", "base", "--allow-empty");
    const base = sh(repo, "rev-parse", "HEAD");
    // The status named it, then it vanished before the diff: the window a real run can hit.
    const result = buildLocalDiff(repo, base, { staged: [], unstaged: [], untracked: ["gone.txt"] });
    expect(result.complete).toBe(false);
    expect(result.excludedFiles).toEqual(["gone.txt"]);
    expect(result.diff).toBe("");
  });

  it("diffs an untracked file larger than a default child-process buffer (#189)", () => {
    const repo = initRepo();
    sh(repo, "commit", "-qm", "base", "--allow-empty");
    const base = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "big-new.txt"), `${"x".repeat(79)}\n`.repeat(20_000));

    const result = buildLocalDiff(repo, base, readWorkingTreeSplit(repo));
    expect(result.excludedFiles).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.diff.length).toBeGreaterThan(1_500_000);
  });

  it("reads a rename from the NUL-separated status without taking the old path as an entry (#189)", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "old name.txt"), "1\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "base");
    sh(repo, "mv", "old name.txt", "new name.txt");
    expect(readWorkingTreeSplit(repo)).toEqual({ staged: ["new name.txt"], unstaged: [], untracked: [] });
  });

  it("treats a staged edit that an unstaged edit undid as no net change, listed and not a gap", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "1\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "base");
    const base = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.txt"), "1\n2\n");
    sh(repo, "add", "a.txt");
    writeFileSync(join(repo, "a.txt"), "1\n");

    const split = readWorkingTreeSplit(repo);
    expect(split.staged).toEqual(["a.txt"]);
    expect(split.unstaged).toEqual(["a.txt"]);
    const result = buildLocalDiff(repo, base, split);
    expect(result.diff).toBe("");
    expect(result.complete).toBe(true);
    expect(result.noNetChangeFiles).toEqual(["a.txt"]);
  });
});

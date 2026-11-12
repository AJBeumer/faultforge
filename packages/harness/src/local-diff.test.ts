import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLocalDiff, countDiffHeaders, parseGitStatus, splitDiffSections, streamId } from "./local-diff.ts";

describe("parseGitStatus", () => {
  it("splits staged, unstaged and untracked paths from git status --porcelain", () => {
    const porcelain = ["M  staged.txt", " M unstaged.txt", "?? untracked.txt", "MM both.txt", "D  removed.txt"].join(
      "\n",
    );
    expect(parseGitStatus(porcelain)).toEqual({
      staged: ["staged.txt", "both.txt", "removed.txt"],
      unstaged: ["unstaged.txt", "both.txt"],
      untracked: ["untracked.txt"],
    });
  });

  it("takes a rename's new path, not the old one", () => {
    expect(parseGitStatus("R  old.txt -> new.txt")).toEqual({ staged: ["new.txt"], unstaged: [], untracked: [] });
  });

  it('leaves an untracked file\'s own name alone, even if it contains " -> "', () => {
    // Only a rename record (status R) ever means " -> " is a separator; an untracked file (status ??)
    // whose literal name contains that sequence must not be split as if it were one.
    expect(parseGitStatus("?? old.txt -> new.txt")).toEqual({
      staged: [],
      unstaged: [],
      untracked: ["old.txt -> new.txt"],
    });
  });

  it("is empty for a clean tree", () => {
    expect(parseGitStatus("")).toEqual({ staged: [], unstaged: [], untracked: [] });
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

    const split = parseGitStatus(status(repo));
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
    expect(result).toEqual({ diff: "", excludedFiles: [], skippedFiles: [], complete: true });
  });

  it("excludes a binary file instead of submitting its content-free summary as reviewed", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "tracked.txt"), "line1\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "base");
    const base = sh(repo, "rev-parse", "HEAD");

    writeFileSync(join(repo, "tracked.txt"), "line1\nline2\n");
    writeFileSync(join(repo, "image.bin"), Buffer.from([0, 1, 2, 0, 3, 4]));

    const split = parseGitStatus(status(repo));
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

    const split = parseGitStatus(status(repo));
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

    const defaultSplit = parseGitStatus(status(repo));
    expect(defaultSplit.untracked).toEqual(["newdir/"]);

    const allSplit = parseGitStatus(status(repo, "--untracked-files=all"));
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

  it("flags a tracked file that is changed but missing from git's diff, never calling the snapshot complete", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "1\n");
    writeFileSync(join(repo, "b.txt"), "1\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "base");
    const base = sh(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.txt"), "1\n2\n");

    // The caller says b.txt changed too, but git's diff holds no section for it (a diff helper or
    // an ignore setting could cause this): that gap must show.
    const result = buildLocalDiff(repo, base, { staged: [], unstaged: ["a.txt", "b.txt"], untracked: [] });
    expect(result.complete).toBe(false);
    expect(result.excludedFiles).toEqual(["b.txt"]);
    expect(result.diff).toContain("diff --git a/a.txt b/a.txt");
  });

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
});

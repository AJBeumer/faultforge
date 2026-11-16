/**
 * The pieces of `review:local` that read the working tree: its staged/unstaged/untracked split, and
 * the inline unified diff Qodo's local review wants to see.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { sha256 } from "../shared/provenance.ts";

export interface WorkingTreeSplit {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/**
 * A path changed both in the index and the worktree is in both lists. Entries end in NUL and are never
 * quoted, so any name is read as written. A rename or copy is followed by its old path, which is skipped.
 */
export function parseGitStatusZ(porcelain: string): WorkingTreeSplit {
  const split: WorkingTreeSplit = { staged: [], unstaged: [], untracked: [] };
  const entries = porcelain.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    if (!entry) continue;
    const x = entry.charAt(0);
    const y = entry.charAt(1);
    const path = entry.slice(3);
    if (/[RC]/.test(x) || /[RC]/.test(y)) i++;
    if (x === "?" && y === "?") {
      split.untracked.push(path);
      continue;
    }
    if (x !== " " && x !== "?") split.staged.push(path);
    if (y !== " " && y !== "?") split.unstaged.push(path);
  }
  return split;
}

/**
 * NUL-separated, because a quoted name names no file and git would diff nothing for it. All untracked
 * files, so a new folder's files are listed one by one.
 */
export function readWorkingTreeSplit(repoRoot: string): WorkingTreeSplit {
  return parseGitStatusZ(git(repoRoot, ["status", "--porcelain", "-z", "--untracked-files=all"]));
}

export interface SkippedFile {
  file: string;
  why: string;
}

export interface DiffBuildResult {
  diff: string;
  excludedFiles: string[];
  skippedFiles: SkippedFile[];
  /** Changed paths whose content equals the base again: nothing to review, and not a gap. */
  noNetChangeFiles: string[];
  complete: boolean;
}

const GIT_MAX_BUFFER = 1024 * 1024 * 1024;

export function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Far above the 1 MiB default: a large patch must be read whole, not throw before anything is saved.
    maxBuffer: GIT_MAX_BUFFER,
  });
}

/** A binary diff has no hunk, so no content reaches Qodo. */
const BINARY_MARKER = /^Binary files .* differ$/m;

export function countDiffHeaders(diffText: string): number {
  return diffText.match(/^diff --git /gm)?.length ?? 0;
}

/**
 * A file name containing " b/" makes git's header ambiguous. Like Qodo's own tool, this takes the greedy
 * reading rather than refuse the whole diff.
 */
export function splitDiffSections(diffText: string): { file: string; body: string }[] {
  const header = /^diff --git a\/.* b\/(.*)$/gm;
  const starts: { index: number; file: string }[] = [];
  for (const m of diffText.matchAll(header)) starts.push({ index: m.index, file: m[1] ?? "" });
  return starts.map((s, i) => ({
    file: s.file,
    body: diffText.slice(s.index, starts[i + 1]?.index ?? diffText.length),
  }));
}

/**
 * `git diff --no-index` exits 1 both when the sides differ and when it can't open the path. So the patch
 * must hold a diff header: a new file, even an empty one, always prints one.
 */
function diffUntrackedFile(repoRoot: string, path: string): { ok: true; patch: string } | { ok: false; why: string } {
  const result = spawnSync(
    "git",
    [
      "-C",
      repoRoot,
      "-c",
      "core.quotePath=false",
      "diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--no-index",
      "--",
      "/dev/null",
      path,
    ],
    // Far above the 1 MiB default: a large new file must be read whole.
    { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER },
  );
  if ((result.status !== 0 && result.status !== 1) || countDiffHeaders(result.stdout ?? "") === 0) {
    const why = (result.stderr || result.error?.message || `git diff --no-index exited ${result.status}`)
      .trim()
      .split("\n")[0];
    return { ok: false, why: (why || "git diff --no-index printed no patch").slice(0, 200) };
  }
  if (BINARY_MARKER.test(result.stdout)) return { ok: false, why: "binary file (no reviewable text content)" };
  return { ok: true, patch: result.stdout };
}

function equalsBase(repoRoot: string, baseSha: string, path: string): boolean {
  const result = spawnSync("git", ["-C", repoRoot, "diff", "--quiet", baseSha, "--", path], { encoding: "utf8" });
  return result.status === 0;
}

/**
 * One `git diff <baseSha>` for tracked files, plus one patch per untracked file. A file whose content can't
 * reach Qodo is listed with why, and `complete` is false: it is never reported as reviewed.
 */
export function buildLocalDiff(repoRoot: string, baseSha: string, split: WorkingTreeSplit): DiffBuildResult {
  // Each piece already ends in its own newline, so they are joined as they are. An extra or trimmed newline
  // breaks the last hunk's line count, and `git apply` calls the patch corrupt.
  let diff = "";
  const excludedFiles: string[] = [];
  const skippedFiles: SkippedFile[] = [];
  const noNetChangeFiles: string[] = [];

  const tracked = git(repoRoot, ["-c", "core.quotePath=false", "diff", "--src-prefix=a/", "--dst-prefix=b/", baseSha]);
  const trackedSections = splitDiffSections(tracked);
  // Two checks, so no unreviewed file passes as reviewed. A quoted header isn't recognised and would fold
  // into the section before it. And a diff helper or ignore setting can leave a changed file out of git's output.
  if (countDiffHeaders(tracked) > trackedSections.length) {
    excludedFiles.push("(unrecognized diff header)");
    skippedFiles.push({
      file: "(unrecognized diff header)",
      why: "a tracked file's diff header wasn't in the plain, unquoted a/… b/… format this command expects",
    });
  }
  const seen = new Set(trackedSections.map((section) => section.file));
  for (const path of new Set([...split.staged, ...split.unstaged])) {
    if (seen.has(path)) continue;
    if (equalsBase(repoRoot, baseSha, path)) {
      noNetChangeFiles.push(path);
      continue;
    }
    excludedFiles.push(path);
    skippedFiles.push({ file: path, why: "changed according to git status, but git's diff held no section for it" });
  }
  for (const section of trackedSections) {
    if (BINARY_MARKER.test(section.body)) {
      excludedFiles.push(section.file);
      skippedFiles.push({ file: section.file, why: "binary file (no reviewable text content)" });
      continue;
    }
    diff += section.body;
  }

  for (const path of split.untracked) {
    const result = diffUntrackedFile(repoRoot, path);
    if (!result.ok) {
      excludedFiles.push(path);
      skippedFiles.push({ file: path, why: result.why });
      continue;
    }
    diff += result.patch;
  }
  return { diff, excludedFiles, skippedFiles, noNetChangeFiles, complete: skippedFiles.length === 0 };
}

/** Qodo keys carried-over findings by this, so it never sees a path it can read. */
export function streamId(worktreeRoot: string): string {
  return sha256(resolve(worktreeRoot));
}

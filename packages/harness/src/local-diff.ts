/**
 * The pieces of `review:local` that read the working tree: its staged/unstaged/untracked split, and
 * the inline unified diff Qodo's local review wants to see.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { sha256 } from "./provenance.ts";

export interface WorkingTreeSplit {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/**
 * The working tree's split from `git status --porcelain -z`. Staged is every path whose index column (X)
 * isn't blank, unstaged every path whose worktree column (Y) isn't blank (a path modified both ways is in
 * both), untracked every `??` path. Entries end in NUL and are never quoted, so a name with a space or
 * a quote is read as written. A rename or copy entry (`R` or `C` in either column) is followed by its old
 * path as a separate entry, which is skipped.
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
 * The working tree's split, read the way the diff is: NUL-separated, so no name is ever quoted (a quoted
 * name names no file, and git would then diff nothing for it), with `--untracked-files=all` so a new
 * folder's files are listed one by one.
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
  /** Paths the status split names whose working-tree content equals the base (a staged edit an
   * unstaged edit undid): nothing to review, and not a gap. */
  noNetChangeFiles: string[];
  complete: boolean;
}

const GIT_MAX_BUFFER = 1024 * 1024 * 1024;

/** Runs a read-only git subcommand in `repoRoot`, throwing on a non-zero exit. */
export function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Far above the 1 MiB default: a large patch must be read whole, not throw before anything is saved.
    maxBuffer: GIT_MAX_BUFFER,
  });
}

/** Git's own marker for a file it diffed as binary: no hunk, so no text content was actually sent. */
const BINARY_MARKER = /^Binary files .* differ$/m;

/** How many `diff --git` header lines the text holds, whatever their quoting. */
export function countDiffHeaders(diffText: string): number {
  return diffText.match(/^diff --git /gm)?.length ?? 0;
}

/**
 * A multi-file `git diff`'s text, split at each `diff --git a/… b/<file>` header. Qodo's own local-
 * review tool warns that a filename containing a literal " b/" can make even git's own header
 * ambiguous; like it, this takes the greedy, common-case reading rather than refuse the whole diff.
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

/** `git diff --no-index` exits 1 when the two sides differ (every call here: one side is `/dev/null`),
 * and 0 would mean the file matched `/dev/null`, which can't happen for a real file. But git also exits
 * 1, with no patch at all, when it can't open the path (a file that vanished after the status was read).
 * So the patch must hold a diff header: a new file, even an empty one, always prints one. A higher exit
 * code, no header, or a binary result (no reviewable text) is reported as a failure here. */
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
    // Far above the 1 MiB default, as for every other git call here: a large new file must be read whole.
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

/** True when git's own comparison finds the path identical to the base (exit 0 of `diff --quiet`). */
function equalsBase(repoRoot: string, baseSha: string, path: string): boolean {
  const result = spawnSync("git", ["-C", repoRoot, "diff", "--quiet", baseSha, "--", path], { encoding: "utf8" });
  return result.status === 0;
}

/**
 * The inline unified diff Qodo's local review wants: committed-since-base, staged and unstaged
 * changes to tracked files in one `git diff <baseSha>` (the working tree already holds all three),
 * plus one `--no-index` patch per untracked file. A file with no reviewable text content — binary, or
 * one git otherwise refuses to diff — is left out of the diff and recorded in
 * `excludedFiles`/`skippedFiles` with why, and `complete` is false: never silently reported as
 * reviewed when its actual content never reached Qodo.
 */
export function buildLocalDiff(repoRoot: string, baseSha: string, split: WorkingTreeSplit): DiffBuildResult {
  // Each piece below is itself a complete, valid multi-file diff (one or more "diff --git" sections,
  // each already ending in its own newline): concatenated directly, with no separator added or any
  // newline trimmed, they read exactly like one `git diff` over every file at once. Joining with an
  // extra "\n", or trimming a piece's trailing one, breaks the last hunk's line count and `git apply`
  // calls it a corrupt patch (seen live: review:local's own first run on itself, 12 November).
  let diff = "";
  const excludedFiles: string[] = [];
  const skippedFiles: SkippedFile[] = [];
  const noNetChangeFiles: string[] = [];

  const tracked = git(repoRoot, ["-c", "core.quotePath=false", "diff", "--src-prefix=a/", "--dst-prefix=b/", baseSha]);
  const trackedSections = splitDiffSections(tracked);
  // Two checks, each of which would otherwise let an unreviewed file pass as reviewed:
  // 1. every "diff --git" line git printed must have become a section (a quoted header, for a name
  //    with a quote, a backslash or a control character, is not recognised and would be folded into
  //    the section before it, wherever it sits);
  // 2. every tracked path the status split names must have a section (a diff helper or an ignore
  //    setting can leave a changed file out of git's output).
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

/** A stable, opaque identity for a worktree: Qodo keys finding carryover by this, never a path it can read. */
export function streamId(worktreeRoot: string): string {
  return sha256(resolve(worktreeRoot));
}

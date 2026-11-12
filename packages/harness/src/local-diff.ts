/**
 * The pieces of `review:local` that read the working tree: its staged/unstaged/untracked split, and
 * the inline unified diff Qodo's local review wants to see.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export interface WorkingTreeSplit {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/**
 * The working tree's split from `git status --porcelain` (v1, no `-z`): staged is every path whose
 * index column (X) isn't blank, unstaged every path whose worktree column (Y) isn't blank — so a path
 * modified both ways (`MM`) appears in both — and untracked every `??` path. A rename's path (status
 * `R`, the only status that ever contains " -> ") is read after it; an untracked file whose own name
 * happens to contain that sequence is left alone, never mistaken for a rename record.
 */
export function parseGitStatus(porcelain: string): WorkingTreeSplit {
  const split: WorkingTreeSplit = { staged: [], unstaged: [], untracked: [] };
  for (const line of porcelain.split("\n")) {
    if (!line) continue;
    const x = line.charAt(0);
    const y = line.charAt(1);
    const rest = line.slice(3);
    const isRename = x === "R" || y === "R";
    const path = isRename && rest.includes(" -> ") ? (rest.split(" -> ").pop() as string) : rest;
    if (x === "?" && y === "?") {
      split.untracked.push(path);
      continue;
    }
    if (x !== " " && x !== "?") split.staged.push(path);
    if (y !== " " && y !== "?") split.unstaged.push(path);
  }
  return split;
}

export interface SkippedFile {
  file: string;
  why: string;
}

export interface DiffBuildResult {
  diff: string;
  excludedFiles: string[];
  skippedFiles: SkippedFile[];
  complete: boolean;
}

/** Runs a read-only git subcommand in `repoRoot`, throwing on a non-zero exit. */
export function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Git's own marker for a file it diffed as binary: no hunk, so no text content was actually sent. */
const BINARY_MARKER = /^Binary files .* differ$/m;

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
 * and 0 would mean the file matched `/dev/null`, which can't happen for a real file — so either exit
 * code is success, never a thrown error. Only a higher exit code, or a binary result (no reviewable
 * text), is reported as a failure here. */
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
    { encoding: "utf8" },
  );
  if (result.status !== 0 && result.status !== 1) {
    const why = (result.stderr || result.error?.message || `git diff --no-index exited ${result.status}`)
      .trim()
      .split("\n")[0];
    return { ok: false, why: (why ?? "").slice(0, 200) };
  }
  if (BINARY_MARKER.test(result.stdout)) return { ok: false, why: "binary file (no reviewable text content)" };
  return { ok: true, patch: result.stdout };
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

  const tracked = git(repoRoot, ["-c", "core.quotePath=false", "diff", "--src-prefix=a/", "--dst-prefix=b/", baseSha]);
  const trackedSections = splitDiffSections(tracked);
  const covered = trackedSections.reduce((n, s) => n + s.body.length, 0);
  if (covered < tracked.length) {
    // Content git produced before the first header this recognizes: most likely a quoted header for
    // a file whose name needs escaping (a quote, a backslash, a control character), which this command
    // can't reliably attribute to a path. Never silently dropped: flagged as incomplete instead, and
    // the sections that did parse are still sent (a real gap, 12 November).
    excludedFiles.push("(unrecognized diff header)");
    skippedFiles.push({
      file: "(unrecognized diff header)",
      why: "a tracked file's diff header wasn't in the plain, unquoted a/… b/… format this command expects",
    });
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
  return { diff, excludedFiles, skippedFiles, complete: skippedFiles.length === 0 };
}

/** A stable, opaque identity for a worktree: Qodo keys finding carryover by this, never a path it can read. */
export function streamId(worktreeRoot: string): string {
  return createHash("sha256").update(resolve(worktreeRoot)).digest("hex");
}

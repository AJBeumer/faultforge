/**
 * Giveaway words in the files of a commit in the reviewed repository (#224, audit H-4). The first case ran
 * while the target's README named this repository; `inject` now refuses a base like that, because the
 * reviewer reads the whole tree, not only the diff.
 */
import { execFileSync } from "node:child_process";
import { telltales } from "./neutral.ts";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Thrown when the tree can't be read in full: the caller refuses, it never treats that as clean. */
export class TreeUnreadable extends Error {}

/**
 * `path: reason` for every tracked file at `commit` in `repo` whose path or text holds a giveaway word, or
 * an empty list. Binary files are read as text too: a word inside one is still visible to a reader. A
 * submodule's entry is a commit of another repository, so only its name is read (Qodo on PR 232). Throws
 * `TreeUnreadable` when git can't list the tree or read a file.
 */
export function baseTreeTelltales(repo: string, commit: string): string[] {
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const detail = (error as { stderr?: string }).stderr?.trim().split("\n")[0] || (error as Error).message;
      throw new TreeUnreadable(`git ${args.slice(0, 2).join(" ")} failed: ${detail}`);
    }
  };
  // "<mode> <type> <object>\t<path>", NUL-separated.
  const entries = git("ls-tree", "-r", "-z", commit)
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [, type] = line.slice(0, tab).split(" ");
      return { type, path: line.slice(tab + 1) };
    });
  const found: string[] = [];
  for (const { type, path } of entries) {
    const text = type === "blob" ? git("show", `${commit}:${path}`) : "";
    const reasons = [...new Set([...telltales(path), ...telltales(text)])];
    if (reasons.length) found.push(`${path}: ${reasons.join(", ")}`);
  }
  return found;
}

/** What `inject` refuses a base for: each giveaway, or that the tree couldn't be read in full. Never throws. */
export function baseTreeProblems(repo: string, commit: string): string[] {
  try {
    return baseTreeTelltales(repo, commit);
  } catch (e) {
    return [`can't read it to check it: ${e instanceof Error ? e.message : String(e)}`];
  }
}

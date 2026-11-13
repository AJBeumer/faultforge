/**
 * Giveaway words in the files of a commit in the reviewed repository (#224, audit H-4). The first case ran
 * while the target's README named this repository; `inject` now refuses a base like that, because the
 * reviewer reads the whole tree, not only the diff.
 */
import { execFileSync } from "node:child_process";
import { telltales } from "./neutral.ts";

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * `path: reason` for every tracked file at `commit` in `repo` whose path or text holds a giveaway word, or
 * an empty list. Binary files are read as text too: a word inside one is still visible to a reader.
 */
export function baseTreeTelltales(repo: string, commit: string): string[] {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, timeout: 120_000 });
  const paths = git("ls-tree", "-r", "-z", "--name-only", commit).split("\0").filter(Boolean);
  const found: string[] = [];
  for (const path of paths) {
    const reasons = [...new Set([...telltales(path), ...telltales(git("show", `${commit}:${path}`))])];
    if (reasons.length) found.push(`${path}: ${reasons.join(", ")}`);
  }
  return found;
}

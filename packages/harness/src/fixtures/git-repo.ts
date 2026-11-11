/**
 * Test fixture: a throwaway git checkout whose `origin/main` holds the given files, for tests that read
 * a repository the way the harness does (through git, at a ref), with no network and no dependence on
 * the CI checkout having any remote ref.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** A new repository with one commit on `main`, also reachable as `origin/main`. */
export function gitRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.org");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "main");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

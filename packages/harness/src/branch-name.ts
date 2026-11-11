/**
 * Derives a free branch name for a case run: the template's base name if nothing uses it yet,
 * otherwise the base name with the smallest free numeric suffix (`<base>-2`, then `-3`, ...). A name
 * counts as taken when it exists locally or on `origin`, so a branch pushed from another checkout
 * (and never fetched here) is never reused.
 */
import { spawnSync } from "node:child_process";

export interface BranchExistence {
  existsLocally(name: string): boolean;
  existsOnOrigin(name: string): boolean;
}

export function deriveBranchName(base: string, git: BranchExistence): string {
  const taken = (name: string) => git.existsLocally(name) || git.existsOnOrigin(name);
  if (!taken(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * Existence checks against a real working copy and its `origin`. `ls-remote --exit-code` tells
 * "confirmed absent" (exit 2) apart from "couldn't tell" (anything else: no network, no such remote, a
 * dead credential): only the former may stand for "free". Treating the latter as free too would let a
 * later push collide with a branch this run never actually saw.
 */
export function gitBranchExistence(dir: string): BranchExistence {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  return {
    existsLocally: (name) => git("rev-parse", "--verify", "--quiet", `refs/heads/${name}`).status === 0,
    existsOnOrigin: (name) => {
      const result = git("ls-remote", "--exit-code", "--heads", "origin", name);
      if (result.status === 0) return true;
      if (result.status === 2) return false;
      throw new Error(`git ls-remote --heads origin ${name} failed: ${(result.stderr ?? "").trim()}`);
    },
  };
}

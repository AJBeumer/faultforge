/**
 * A run's workspace on disk: where each repo's worktree goes, how it is removed again, and the fingerprints
 * of what the agent must not change. Split from factory-tick.ts (#227).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { FactoryConfig } from "./factory-config.ts";
import { git } from "./factory-exec.ts";
import { ROOT as LAB_ROOT } from "./paths.ts";

/** The key for the private evidence repo in `Workspace.mainAtStart`. */
export const PRIVATE_KEY = "(private)";

/**
 * `local`: the owner's PC. Worktrees per run, a lock file, and the owner's checkouts are fingerprinted.
 * `ci`: a GitHub Actions run on a fresh VM. The workflow has checked out every repo next to this one, in
 * the same layout; those checkouts are the workspace. The workflow's concurrency group is the lock.
 */
export type RunMode = "local" | "ci";

/** Worktree folder for a repo: its configured path, resolved from the lab's worktree. */
export const worktreeFor = (labWt: string, path: string) => resolve(labWt, path);

/**
 * Whether two paths name the same folder. Real paths on both sides, as `ledger-check.ts` does: on Windows a
 * temp folder can be given by its short 8.3 name (RUNNER~1) while git reports the long one, and the drive
 * letter's case can differ. A path that doesn't exist falls back to plain resolution.
 */
export function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  };
  const [x, y] = [real(a), real(b)];
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Removes a run's worktrees, its private branch and its folder, as far as they exist. Each step is
 * tried on its own; returns what couldn't be removed. The private worktree sits inside the lab's
 * worktree, so it goes first, through its own repo.
 */
export function teardown(
  factory: FactoryConfig,
  privateRepo: string,
  root: string,
  lab: string,
  priv: string,
  runId: string,
): string[] {
  const failed: string[] = [];
  const attempt = (what: string, step: () => void) => {
    try {
      step();
    } catch (error) {
      failed.push(`${what}: ${(error as Error).message.split("\n")[0]}`);
    }
  };
  const registered = (repo: string, path: string) =>
    git(repo, "worktree", "list", "--porcelain")
      .split("\n")
      .some((line) => line.startsWith("worktree ") && samePath(line.slice(9), path));
  if (registered(privateRepo, priv))
    attempt("private worktree", () => git(privateRepo, "worktree", "remove", "--force", priv));
  if (git(privateRepo, "branch", "--list", `run-${runId}`))
    attempt("private branch", () => git(privateRepo, "branch", "-D", `run-${runId}`));
  for (const repo of Object.values(factory.repos)) {
    const source = resolve(LAB_ROOT, repo.path);
    const path = repo.path === "." ? lab : worktreeFor(lab, repo.path);
    if (repo.path !== "." && registered(source, path))
      attempt(`${basename(path)} worktree`, () => git(source, "worktree", "remove", "--force", path));
  }
  if (registered(LAB_ROOT, lab)) attempt("lab worktree", () => git(LAB_ROOT, "worktree", "remove", "--force", lab));
  attempt("run folder", () => rmSync(root, { recursive: true, force: true }));
  return failed;
}

/**
 * Fingerprints of what the agent must not change: the owner's own checkouts (commit, branch and
 * uncommitted changes) and the guardrail files in the run's lab worktree.
 */
export function fingerprints(
  factory: FactoryConfig,
  privateRepo: string,
  mode: RunMode,
  lab: string,
): Record<string, string> {
  const prints: Record<string, string> = {};
  // In CI the checkouts are the agent's own workspace, and no owner checkout exists to protect.
  const checkouts =
    mode === "ci" ? [] : [LAB_ROOT, privateRepo, ...Object.values(factory.repos).map((r) => resolve(LAB_ROOT, r.path))];
  for (const dir of new Set(checkouts)) {
    prints[`the owner's checkout ${dir}`] = hash(
      `${git(dir, "rev-parse", "HEAD")}\n${git(dir, "branch", "--show-current")}\n${git(dir, "status", "--porcelain")}`,
    );
  }
  // Every file under .claude: settings, hooks and the skills the agent follows.
  const guardrails = join(lab, ".claude");
  const files = (readdirSync(guardrails, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => relative(guardrails, join(entry.parentPath, entry.name)).replace(/\\/g, "/"))
    .sort();
  prints[`the run's guardrail files (${guardrails})`] = hash(
    files.map((f) => `${f}\n${readFileSync(join(guardrails, f), "utf8")}`).join("\n"),
  );
  return prints;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

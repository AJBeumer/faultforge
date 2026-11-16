/**
 * Publishing a run's log and evidence to the private repo: only paths under the allowed evidence roots ever
 * reach its `main`.
 */
import type { FactoryConfig } from "../shared/factory-config.ts";

/**
 * True when a git-reported path is `prefix` itself or inside it. Never trims `path`: a leading space is part
 * of the real file name, and trimming it would let a root-level file pass as under the evidence root.
 */
function underEvidencePrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Of `paths` (as git reports them), the ones outside both allowed evidence roots: the configured evidence
 * root and `factory-log`. The answer key and audit log must stay append-only, so the factory must never be
 * the one to rewrite them. Drops only the blank entry a trailing newline leaves, never a path's whitespace.
 */
export function blockedEvidencePaths(paths: string[], evidenceRoot: string): string[] {
  return paths.filter(
    (p) => p !== "" && !underEvidencePrefix(p, evidenceRoot) && !underEvidencePrefix(p, "factory-log"),
  );
}

/**
 * Every path that differs between `priv`'s worktree (committed or not) and `base`, the commit the run started
 * on. Each command prints a bare path per line: `git status --porcelain`'s status letters could be mistaken
 * for part of a path once the output is trimmed. `--no-renames` splits a rename, so a protected file moved
 * under the evidence root still shows its old, now-missing path.
 */
function changedAgainst(priv: string, run: (cwd: string, ...args: string[]) => string, base: string): string[] {
  const lines = (s: string) => s.split("\n").filter((p) => p !== "");
  const committed = lines(run(priv, "diff", "--no-renames", "--name-only", base, "HEAD"));
  const uncommitted = lines(run(priv, "diff", "--no-renames", "--name-only", "HEAD"));
  const untracked = lines(run(priv, "ls-files", "--others", "--exclude-standard"));
  return [...new Set([...committed, ...uncommitted, ...untracked])];
}

export interface EvidencePush {
  /** True once the private branch's commits reached `main`. */
  pushed: boolean;
  /** Changed paths outside the allowed evidence roots; empty when the push went through. */
  blocked: string[];
  /** Where a blocked run's commits were kept instead (a branch name), if that push itself succeeded. */
  savedAt?: string;
}

/** A single attempt would lose a blocked run's evidence to a passing network failure. */
const QUARANTINE_PUSH_ATTEMPTS = 3;

/**
 * Decides, from the paths `priv`'s branch changed since `base` and before anything is committed, whether the
 * branch may reach `main`: every path must be under an allowed evidence root, or nothing does. Then it commits
 * and pushes either to `main` or, when blocked, to a branch of its own so the owner can still read it.
 * `main` never moves when blocked.
 */
export function commitAndPublish(
  priv: string,
  evidenceRoot: string,
  runId: string,
  run: (cwd: string, ...args: string[]) => string,
  runLong: (cwd: string, ...args: string[]) => string,
  base?: string,
): EvidencePush {
  runLong(priv, "fetch", "--quiet", "origin", "main");
  // From where the run's branch left `origin/main`, not `origin/main` as fetched now: that would count anyone
  // else's push during the run as the run's change. `base` is for tests.
  const from = base ?? run(priv, "merge-base", "origin/main", "HEAD");
  const blocked = blockedEvidencePaths(changedAgainst(priv, run, from), evidenceRoot);
  run(priv, "add", "-A");
  if (run(priv, "status", "--porcelain"))
    run(priv, "commit", "--quiet", "-m", `Factory run ${runId}: log and evidence`);
  run(priv, "rebase", "--quiet", "origin/main");
  if (blocked.length) {
    const branch = `blocked-${runId}`;
    let savedAt: string | undefined;
    for (let attempt = 0; attempt < QUARANTINE_PUSH_ATTEMPTS && !savedAt; attempt++) {
      try {
        runLong(priv, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
        savedAt = branch;
      } catch {
        // Left undefined, the kept run folder is the last copy, and it is lost with a CI run's machine.
      }
    }
    return { pushed: false, blocked, savedAt };
  }
  runLong(priv, "push", "--quiet", "origin", "HEAD:main");
  return { pushed: true, blocked: [] };
}

/** Where a run's log is saved, relative to this repo. */
export function evidenceFile(factory: FactoryConfig, runId: string): string {
  return `${factory.evidence}/factory-runs/${runId}.jsonl`;
}

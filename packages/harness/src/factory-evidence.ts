/**
 * Publishing a run's log and evidence to the private repo: only paths under the allowed evidence roots ever
 * reach its `main` (#102). Split from factory-tick.ts (#227).
 */
import type { FactoryConfig } from "./factory-config.ts";

/**
 * True when a git-reported path is `prefix` itself or inside it. Never trims or otherwise normalises
 * `path`: a leading or trailing space is part of the real filename git is naming, not formatting noise,
 * and treating ` raw-artifacts/x` as `raw-artifacts/x` would let a root-level path with a stray space
 * pass as if it were under the evidence root when the file it names is not (Qodo on PR 141).
 */
function underEvidencePrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Of `paths` (as git reports them, forward-slash, unmodified), the ones that fall outside both allowed
 * evidence roots: the configured evidence root (e.g. `raw-artifacts`) and `factory-log`. Only these ever
 * stop a push to the private repo's `main` (#102): the answer key and audit log must stay append-only,
 * and the factory must never be the one to rewrite them. Only drops lines that are genuinely blank (the
 * trailing empty entry `split("\n")` leaves after the last newline), never a path's own whitespace.
 */
export function blockedEvidencePaths(paths: string[], evidenceRoot: string): string[] {
  return paths.filter(
    (p) => p !== "" && !underEvidencePrefix(p, evidenceRoot) && !underEvidencePrefix(p, "factory-log"),
  );
}

/**
 * Every path that differs between `priv`'s worktree (as it stands right now, committed or not) and `base`,
 * the commit the run started on: committed changes made earlier in the run, plus whatever is modified or
 * untracked in the working tree. Every one of the three commands below prints a bare path per line, nothing else —
 * deliberately never `git status --porcelain`, whose leading status characters can be mistaken for part
 * of the path once the shared `git`/`gitLong` helpers (used here, same as everywhere else) have trimmed
 * the overall output: a path that starts with its own letter can then read as if a status prefix were
 * still attached to it, or the reverse (Qodo on PR 141, round 2). `--no-renames` forces a rename apart
 * into its old and new paths, so a protected file moved under the evidence root still shows its old,
 * now-missing path — `--name-only` alone would report only the allowed destination and hide that the
 * source was removed from `main`.
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

/** How many times a blocked run's quarantine push is retried before giving up on it (Qodo on PR 141: a
 *  single attempt loses the evidence to a transient failure as surely as to a real one). */
const QUARANTINE_PUSH_ATTEMPTS = 3;

/**
 * Lists every path `priv`'s branch changed since `base` (the commit the run started on; by default where its
 * branch left `origin/main`), before anything is staged or committed
 * (#102), and decides from that list alone whether the branch may reach `main`: every path must be under
 * one of the allowed evidence roots, or nothing does. Only once that's decided does it commit what's
 * there, and push it either to `main` (allowed) or to a branch of its own (blocked, so the owner still has
 * somewhere to read it, retried a few times against a transient failure); `main` never moves when blocked.
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
  // The run's own changes only: from the commit it started on, never from `origin/main` as fetched now,
  // which would count anyone else's push during the run as the run's change and report its paths (AUD-M2).
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
        // Retried, up to the attempt limit; left undefined, the kept worktree/run folder is the
        // last-resort copy, and that one is not durable once a CI run's own VM is discarded (#102,
        // disclosed in the PR: durable delivery through that case needs a workflow-level fix, out of
        // scope for an unattended run that may not touch .github/workflows).
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

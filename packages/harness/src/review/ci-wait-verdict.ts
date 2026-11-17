/**
 * What ci:wait judges, with no git call and no read of GitHub: which runs are its own, whether they are done,
 * whether the jobs and runs passed, and whether a remote address is the configured repository. Pure, so each
 * rule is tested on its own; `ci-wait.ts` does the pushing and the waiting.
 */
import { githubRemote } from "../../../../.claude/hooks/shared/repos.ts";

/** One workflow run GitHub started. */
export interface WorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
}

/** One job of a workflow run. */
export interface Job {
  name: string;
  status: string;
  conclusion: string | null;
}

/**
 * The scratch branch of one wait: by the commit, the moment, and a few characters the wait drew at random. So
 * no two waits share a branch, even two for one commit that start in the same millisecond.
 */
export function scratchBranch(sha: string, now: number, nonce: string): string {
  return `ci-wait/${sha.slice(0, 12)}-${now.toString(36)}-${nonce}`;
}

/** The runs that are this wait's own: started for its branch, at its commit. */
export function ownRuns(runs: WorkflowRun[], branch: string, sha: string): WorkflowRun[] {
  return runs.filter((run) => run.head_branch === branch && run.head_sha === sha);
}

/** True once at least one run has started and every one of them has finished. */
export function runsFinished(runs: WorkflowRun[]): boolean {
  return runs.length > 0 && runs.every((run) => run.status === "completed");
}

const PASSING = ["success", "skipped", "neutral"];

/**
 * Pure: the verdict on the finished runs' jobs. It passes only when every job ended as success, skipped or
 * neutral, and every job in `required` (the repository's `ciJobs`) ran and ended as success. The required
 * jobs are named, never guessed from what ran: a commit whose Windows job was skipped or never started is
 * not green, however many other jobs passed. With no required job named, nothing passes.
 */
export function jobsVerdict(jobs: Job[], required: string[]): { passed: boolean; failed: string[]; lines: string[] } {
  const sorted = [...jobs].sort((a, b) => a.name.localeCompare(b.name));
  const lines = sorted.map((job) => `  ${job.name}: ${job.status === "completed" ? job.conclusion : job.status}`);
  const failed = sorted
    .filter((job) => job.status !== "completed" || !PASSING.includes(job.conclusion ?? ""))
    .map((job) => job.name);
  const succeeded = new Set(sorted.filter((job) => job.conclusion === "success").map((job) => job.name));
  const missing = required
    .filter((name) => !succeeded.has(name) && !failed.includes(name))
    .map((name) => `${name} (required, did not run)`);
  const all = [...failed, ...missing];
  return { passed: required.length > 0 && all.length === 0, failed: all, lines };
}

/** The finished runs that did not end as success, skipped or neutral, each named with how it ended. */
export function failedRuns(runs: WorkflowRun[]): string[] {
  return runs
    .filter((run) => !PASSING.includes(run.conclusion ?? ""))
    .map((run) => `the ${run.name} workflow (${run.conclusion ?? "no result"})`)
    .sort();
}

/**
 * True when a git remote address names the GitHub repository `github` (`owner/name`), read by the one exact
 * reader the door uses too (`githubRemote` in the guard's `shared/repos.ts`): the whole address must be on
 * github.com itself, never one that only mentions it.
 */
export function remoteIs(url: string, github: string): boolean {
  return githubRemote(url.trim()) === github.toLowerCase();
}

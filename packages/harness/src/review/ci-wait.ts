/**
 * Runs the repository's checks on the current commit, on every operating system CI covers, before that
 * commit reaches a pull request.
 *
 *   npm run ci:wait -- faultforge
 *   npm run ci:wait -- faultforge --timeout 9
 *
 * It pushes the current commit to a scratch branch of its own that has no pull request, waits for the
 * workflow runs GitHub starts for that branch, prints each job with its result, and deletes the branch. CI
 * runs on any pushed branch; the reviewer only reads pull requests. So a failure that shows on one operating
 * system alone is found here, and costs no review round.
 *
 * Only runs of this wait's own branch count: the same commit may have been checked before, on another
 * branch or by an earlier wait, and those results are not this wait's. The jobs are read from the finished
 * runs themselves, so a job can't be missing from the list while its run is done.
 *
 * It checks the commit, never the working tree: with uncommitted changes it refuses, because they would not
 * be in what CI runs. It works for a lab repository only, and only when the checkout's `origin` is that
 * repository on GitHub. A reviewed repository is written through the door and nowhere else, so there it refuses.
 *
 * Its last line is always `ci:wait exit <code>`, so a log can keep the code.
 *
 * Exit codes: 0 every job passed; 1 a job failed, named in the output; 2 it could not run or could not tell
 * (a bad argument, a reviewed repository, an `origin` that is another repository, uncommitted changes, the
 * push failed, GitHub could not be read, no check ran, or the runs didn't finish in time), or an unexpected
 * error stopped it, even while loading (`npm run ci:wait` runs `ci-wait-cli.ts`).
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadFactory, repoConfig } from "../shared/factory-config.ts";
import { ghJson } from "../shared/github.ts";
import { ROOT } from "../shared/paths.ts";

export interface CiWaitArgs {
  repoKey: string;
  timeoutMinutes: number;
}

/** The command line, or null when it's wrong. */
export function parseCiWaitArgs(argv: string[]): CiWaitArgs | null {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { timeout: { type: "string" } },
      allowPositionals: true,
    });
    const [repoKey, ...rest] = positionals;
    const timeoutMinutes = values.timeout === undefined ? 25 : Number(values.timeout);
    if (!repoKey || rest.length || !Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return null;
    return { repoKey, timeoutMinutes };
  } catch {
    return null;
  }
}

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

/** The scratch branch of one wait: by the commit and the moment, so no two waits ever share a branch. */
export function scratchBranch(sha: string, now: number): string {
  return `ci-wait/${sha.slice(0, 12)}-${now.toString(36)}`;
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
 * neutral and at least one really ran and succeeded: a commit whose jobs were all skipped proves nothing.
 */
export function jobsVerdict(jobs: Job[]): { passed: boolean; failed: string[]; lines: string[] } {
  const sorted = [...jobs].sort((a, b) => a.name.localeCompare(b.name));
  const lines = sorted.map((job) => `  ${job.name}: ${job.status === "completed" ? job.conclusion : job.status}`);
  const failed = sorted
    .filter((job) => job.status !== "completed" || !PASSING.includes(job.conclusion ?? ""))
    .map((job) => job.name);
  const ran = sorted.some((job) => job.conclusion === "success");
  return { passed: failed.length === 0 && ran, failed: failed.length || ran ? failed : ["(no job ran)"], lines };
}

/** True when a git remote address names the GitHub repository `github` (`owner/name`), by https or ssh. */
export function remoteIs(url: string, github: string): boolean {
  const match = url
    .trim()
    .match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(.+?)(?:\.git)?\/?$/i);
  return match?.[1]?.toLowerCase() === github.toLowerCase();
}

/** What the command needs from the world, so a test can run it whole. */
export interface CiWaitDeps {
  git: (cwd: string, ...args: string[]) => string;
  /** The workflow runs GitHub lists for a branch. */
  runs: (github: string, branch: string) => WorkflowRun[];
  /** Every job of one run. */
  jobs: (github: string, runId: number) => Job[];
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  out: (line: string) => void;
  error: (line: string) => void;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const realDeps: CiWaitDeps = {
  git,
  runs: (github, branch) =>
    ghJson<{ workflow_runs: WorkflowRun[] }>(
      "api",
      `repos/${github}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=100`,
    ).workflow_runs,
  jobs: (github, runId) =>
    ghJson<{ jobs: Job[] }[]>(
      "api",
      "--paginate",
      "--slurp",
      `repos/${github}/actions/runs/${runId}/jobs?per_page=100`,
    ).flatMap((page) => page.jobs),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: Date.now,
  out: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** How long to wait for GitHub to start a check after the push before saying none ran. */
export const START_LIMIT_MS = 5 * 60_000;
const POLL_MS = 20_000;

/** The wait itself, once the branch is pushed: 0, 1 or 2. */
async function wait(
  args: CiWaitArgs,
  github: string,
  branch: string,
  sha: string,
  deps: CiWaitDeps,
): Promise<0 | 1 | 2> {
  const started = deps.now();
  const deadline = started + args.timeoutMinutes * 60_000;
  let jobs: Job[] = [];
  let seen = "";
  let everRead = false;
  let ranJob = false;
  let lastError = "";
  for (;;) {
    let runs: WorkflowRun[] = [];
    let settled = false;
    try {
      runs = ownRuns(deps.runs(github, branch), branch, sha);
      everRead = true;
      if (runsFinished(runs)) {
        jobs = runs.flatMap((run) => deps.jobs(github, run.id));
        // A workflow that only skips itself is listed before the one that runs the checks. So the answer
        // counts only when a job really ran, and when the same runs were there on the poll before: a
        // run GitHub lists a moment later is then still waited for.
        const ran = jobs.some(
          (job) => job.status !== "completed" || !["skipped", "neutral"].includes(job.conclusion ?? ""),
        );
        const ids = runs
          .map((run) => run.id)
          .sort()
          .join(",");
        ranJob = ran;
        settled = ran && ids === seen;
        seen = ids;
      } else seen = "";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      deps.error(`ci:wait: a poll failed, trying again: ${lastError}`);
    }
    if (settled) break;
    const now = deps.now();
    if (now - started > START_LIMIT_MS && (!runs.length || runsFinished(runs)) && !ranJob) {
      // Never read GitHub at all: that is not the same as a workflow that didn't start.
      deps.error(
        everRead
          ? "ci:wait: GitHub ran no check for this commit, so nothing was checked."
          : `ci:wait: GitHub could not be read, so there is no result: ${lastError}`,
      );
      return 2;
    }
    if (now > deadline) {
      deps.error(`ci:wait: the checks didn't finish in ${args.timeoutMinutes} minutes, so there is no result.`);
      return 2;
    }
    await deps.sleep(POLL_MS);
  }
  const verdict = jobsVerdict(jobs);
  for (const line of verdict.lines) deps.out(line);
  if (verdict.passed) {
    deps.out(`ci:wait: every job passed on ${sha.slice(0, 7)}.`);
    return 0;
  }
  deps.out(`ci:wait: not green on ${sha.slice(0, 7)}: ${verdict.failed.join(", ")}`);
  return 1;
}

/** Everything before and after the wait: the refusals, the push, and the branch's removal. */
async function body(argv: string[], deps: CiWaitDeps): Promise<0 | 1 | 2> {
  const factory = loadFactory();
  const args = parseCiWaitArgs(argv);
  if (!args || !factory.repos[args.repoKey]) {
    deps.error(`usage: npm run ci:wait -- <${Object.keys(factory.repos).join("|")}> [--timeout minutes]`);
    return 2;
  }
  const repo = repoConfig(factory, args.repoKey);
  if (repo.guard === "reviewed") {
    deps.error(
      `ci:wait: ${args.repoKey} is a reviewed repository. Nothing is pushed there outside the door, so its checks run on the pull request only.`,
    );
    return 2;
  }
  const checkout = resolve(ROOT, repo.path);
  let sha: string;
  try {
    // The scratch branch goes to `origin`, and the checks are read from the configured repository: they
    // must be one and the same, or the branch lands in a fork and the wait watches somewhere else.
    if (!remoteIs(deps.git(checkout, "remote", "get-url", "origin"), repo.github)) {
      deps.error(`ci:wait: this checkout's origin is not github.com/${repo.github}, so nothing was pushed.`);
      return 2;
    }
    if (deps.git(checkout, "status", "--porcelain")) {
      deps.error("ci:wait: there are uncommitted changes. It checks the commit, so commit first.");
      return 2;
    }
    sha = deps.git(checkout, "rev-parse", "HEAD");
  } catch (e) {
    deps.error(`ci:wait: couldn't read the checkout: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const branch = scratchBranch(sha, deps.now());
  try {
    deps.git(checkout, "push", "--quiet", "origin", `${sha}:refs/heads/${branch}`);
  } catch (e) {
    deps.error(`ci:wait: couldn't push the scratch branch: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  deps.out(`Pushed ${sha.slice(0, 7)} to ${branch}; waiting for its checks (up to ${args.timeoutMinutes} min)…`);
  try {
    return await wait(args, repo.github, branch, sha, deps);
  } catch (e) {
    deps.error(`ci:wait: couldn't read the checks: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  } finally {
    // Whatever the result: a scratch branch left behind would be one more branch nobody owns.
    try {
      deps.git(checkout, "push", "--quiet", "origin", "--delete", branch);
    } catch (e) {
      deps.error(
        `ci:wait: couldn't delete ${branch}; delete it by hand: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** The command's body: its result, and then its last line, which names the exit code. */
export async function run(argv: string[], deps: CiWaitDeps = realDeps): Promise<number> {
  const code = await body(argv, deps);
  deps.out(`ci:wait exit ${code}`);
  return code;
}

/** The command: `ci-wait-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(argv: string[]): Promise<number> {
  return run(argv);
}

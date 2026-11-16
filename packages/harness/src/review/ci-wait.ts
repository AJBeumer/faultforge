/**
 * Runs the repository's checks on the current commit, on every operating system CI covers, before that
 * commit reaches a pull request.
 *
 *   npm run ci:wait -- faultforge
 *   npm run ci:wait -- faultforge --timeout 30
 *
 * It pushes the current commit to a scratch branch that has no pull request (`ci-wait/<commit>`), waits for
 * the workflow runs GitHub starts for exactly that commit, prints each job with its result, and deletes the
 * scratch branch. CI runs on any pushed branch; the reviewer only reads pull requests. So a failure that
 * shows on one operating system alone is found here, and costs no review round.
 *
 * It checks the commit, never the working tree: with uncommitted changes it refuses, because they would not
 * be in what CI runs. It works for a lab repository only. A reviewed repository is written through the door
 * and nowhere else, so there it refuses.
 *
 * Exit codes: 0 every job passed; 1 a job failed, named in the output; 2 it could not run or could not tell
 * (a bad argument, a reviewed repository, uncommitted changes, the push failed, no run started, or the runs
 * didn't finish in time), or an unexpected error stopped it, even while loading (`npm run ci:wait` runs
 * `ci-wait-cli.ts`).
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

/** One workflow run GitHub started for the commit. */
export interface WorkflowRun {
  name: string;
  status: string;
  conclusion: string | null;
}

/** One job (check run) of the commit. */
export interface Job {
  name: string;
  status: string;
  conclusion: string | null;
}

/** The scratch branch for a commit: by its id, so two waits for different commits never share one. */
export function scratchBranch(sha: string): string {
  return `ci-wait/${sha.slice(0, 12)}`;
}

/** True once at least one run has started for the commit and every one of them has finished. */
export function runsFinished(runs: WorkflowRun[]): boolean {
  return runs.length > 0 && runs.every((run) => run.status === "completed");
}

const PASSING = ["success", "skipped", "neutral"];

/**
 * Pure: the verdict on a commit's finished jobs. It passes only when every job ended as success, skipped or
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

/** What the command needs from the world, so a test can run it whole. */
export interface CiWaitDeps {
  git: (cwd: string, ...args: string[]) => string;
  runs: (github: string, sha: string) => WorkflowRun[];
  jobs: (github: string, sha: string) => Job[];
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  out: (line: string) => void;
  error: (line: string) => void;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const realDeps: CiWaitDeps = {
  git,
  runs: (github, sha) =>
    ghJson<{ workflow_runs: WorkflowRun[] }>("api", `repos/${github}/actions/runs?head_sha=${sha}&per_page=100`)
      .workflow_runs,
  jobs: (github, sha) =>
    ghJson<{ check_runs: Job[] }>("api", `repos/${github}/commits/${sha}/check-runs?per_page=100`).check_runs,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: Date.now,
  out: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** How long to wait for GitHub to start a run after the push before saying none started. */
export const START_LIMIT_MS = 5 * 60_000;
const POLL_MS = 20_000;

/** The command's body. */
export async function run(argv: string[], deps: CiWaitDeps = realDeps): Promise<number> {
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
    if (deps.git(checkout, "status", "--porcelain")) {
      deps.error("ci:wait: there are uncommitted changes. It checks the commit, so commit first.");
      return 2;
    }
    sha = deps.git(checkout, "rev-parse", "HEAD");
  } catch (e) {
    deps.error(`ci:wait: couldn't read the checkout: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const branch = scratchBranch(sha);
  try {
    deps.git(checkout, "push", "--quiet", "origin", `${sha}:refs/heads/${branch}`);
  } catch (e) {
    deps.error(`ci:wait: couldn't push the scratch branch: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  deps.out(`Pushed ${sha.slice(0, 7)} to ${branch}; waiting for its checks (up to ${args.timeoutMinutes} min)…`);
  try {
    const started = deps.now();
    const deadline = started + args.timeoutMinutes * 60_000;
    let jobs: Job[] = [];
    for (;;) {
      let runs: WorkflowRun[] = [];
      try {
        runs = deps.runs(repo.github, sha);
        jobs = runsFinished(runs) ? deps.jobs(repo.github, sha) : [];
      } catch (e) {
        deps.error(`ci:wait: a poll failed, trying again: ${e instanceof Error ? e.message : String(e)}`);
        runs = [];
      }
      // Finished, and a job really ran: GitHub lists a workflow that skips itself before it lists the one
      // that runs the checks, and that moment must not read as "everything finished".
      const ran = jobs.some(
        (job) => job.status !== "completed" || !["skipped", "neutral"].includes(job.conclusion ?? ""),
      );
      if (runsFinished(runs) && ran) break;
      const now = deps.now();
      if (now - started > START_LIMIT_MS && !ran && (!runs.length || runsFinished(runs))) {
        deps.error("ci:wait: GitHub ran no check for this commit, so nothing was checked.");
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

/** The command: `ci-wait-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(argv: string[]): Promise<number> {
  return run(argv);
}

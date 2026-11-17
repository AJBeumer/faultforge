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
 * The jobs that must pass are named in `factory.json` (the repository's `ciJobs`), by the names GitHub shows.
 * Each must have run and succeeded. A job that is not named still fails the wait when it fails.
 *
 * Exit codes: 0 every job passed, each required one by running; 1 a job failed or a required job did not
 * run, named in the output; 2 it could not run or could not tell (a bad argument, a reviewed repository, a
 * repository with no `ciJobs`, an `origin` that is another repository, uncommitted changes, the
 * push failed, GitHub could not be read, no check ran, the runs didn't finish in time, or every job passed
 * but the scratch branch could not be deleted), or an unexpected error stopped it, even while loading
 * (`npm run ci:wait` runs `ci-wait-cli.ts`).
 *
 * The time limit runs from the command's start and covers the push and every read of GitHub. Removing the
 * branch comes after it and may take up to `GIT_TIMEOUT_MS` more. No git call may take longer than that, so
 * the command ends itself and is never killed with its branch left behind.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { reviewedRepos } from "../../../../.claude/hooks/shared/repos.ts";
import { loadFactory, repoConfig } from "../shared/factory-config.ts";
import { callDeadline, ghJson } from "../shared/github.ts";
import { ROOT } from "../shared/paths.ts";
import {
  failedRuns,
  type Job,
  jobsVerdict,
  ownRuns,
  remoteIs,
  runsFinished,
  scratchBranch,
  type WorkflowRun,
} from "./ci-wait-verdict.ts";

export {
  failedRuns,
  type Job,
  jobsVerdict,
  ownRuns,
  remoteIs,
  runsFinished,
  scratchBranch,
  type WorkflowRun,
} from "./ci-wait-verdict.ts";

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

/** What the command needs from the world, so a test can run it whole. */
export interface CiWaitDeps {
  git: (cwd: string, ...args: string[]) => string;
  /** The workflow runs GitHub lists for a branch. */
  runs: (github: string, branch: string) => WorkflowRun[];
  /** Every job of one run. */
  jobs: (github: string, runId: number) => Job[];
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** A few random characters for the scratch branch's name. */
  nonce: () => string;
  out: (line: string) => void;
  error: (line: string) => void;
}

/** The longest one git call may take. A stalled push ends here, and the command still removes its branch. */
export const GIT_TIMEOUT_MS = 30_000;

/**
 * The time one git call may take: `GIT_TIMEOUT_MS`, cut to what is left before `deadlineAt` when one is set,
 * and never under a second, so a call made at the limit still fails cleanly instead of at once.
 */
export function gitTimeout(now: number, deadlineAt: number | undefined): number {
  return deadlineAt === undefined ? GIT_TIMEOUT_MS : Math.max(1_000, Math.min(GIT_TIMEOUT_MS, deadlineAt - now));
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: gitTimeout(Date.now(), callDeadline.at),
  }).trim();

const realDeps: CiWaitDeps = {
  git,
  runs: (github, branch) =>
    ghJson<{ workflow_runs: WorkflowRun[] }[]>(
      "api",
      "--paginate",
      "--slurp",
      `repos/${github}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=100`,
    ).flatMap((page) => page.workflow_runs),
  jobs: (github, runId) =>
    ghJson<{ jobs: Job[] }[]>(
      "api",
      "--paginate",
      "--slurp",
      `repos/${github}/actions/runs/${runId}/jobs?per_page=100`,
    ).flatMap((page) => page.jobs),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: Date.now,
  nonce: () => randomBytes(4).toString("hex"),
  out: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** How long to wait for GitHub to start a check after the push before saying none ran. */
export const START_LIMIT_MS = 5 * 60_000;
const POLL_MS = 20_000;

/** The wait itself, once the branch is pushed: 0, 1 or 2. `deadline` is the command's, set before the push. */
async function wait(
  args: CiWaitArgs,
  github: string,
  branch: string,
  sha: string,
  required: string[],
  deadline: number,
  deps: CiWaitDeps,
): Promise<0 | 1 | 2> {
  const started = deps.now();
  let jobs: Job[] = [];
  let finished: WorkflowRun[] = [];
  let seen = "";
  let everRead = false;
  let lastFailed = false;
  let ranJob = false;
  let lastError = "";
  for (;;) {
    let runs: WorkflowRun[] = [];
    let settled = false;
    try {
      runs = ownRuns(deps.runs(github, branch), branch, sha);
      everRead = true;
      lastFailed = false;
      if (runsFinished(runs)) {
        finished = runs;
        jobs = runs.flatMap((run) => deps.jobs(github, run.id));
        // A workflow that only skips itself is listed before the one that runs the checks. So the answer
        // counts only when a job really ran, and when the same runs were there on the poll before: a
        // run GitHub lists a moment later is then still waited for.
        const ran = jobs.some(
          (job) => job.status !== "completed" || !["skipped", "neutral"].includes(job.conclusion ?? ""),
        );
        // The runs and their jobs must read the same on two polls in a row, so a job GitHub lists late is waited for.
        const ids = JSON.stringify([
          runs.map((run) => run.id).sort(),
          jobs.map((job) => `${job.name}:${job.status}:${job.conclusion}`).sort(),
        ]);
        ranJob = ran;
        // A run that failed is an answer even with no job that ran (a workflow that failed before any job).
        const failed = failedRuns(runs).length > 0;
        // A required job may come in a workflow GitHub starts later: until each one is listed, it is waited for,
        // up to the start limit. Then a job still missing counts as not run.
        const complete = required.every((name) => jobs.some((job) => job.name === name));
        settled = (ran || failed) && ids === seen && (complete || failed || deps.now() - started > START_LIMIT_MS);
        seen = ids;
      } else seen = "";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      lastFailed = true;
      deps.error(`ci:wait: a poll failed, trying again: ${lastError}`);
    }
    if (settled) break;
    const now = deps.now();
    if (now - started > START_LIMIT_MS && (!runs.length || runsFinished(runs)) && !ranJob) {
      // A GitHub that can't be read now is not the same as a workflow that didn't start.
      deps.error(
        everRead && !lastFailed
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
  const verdict = jobsVerdict(jobs, required);
  // A run's own result counts too: a failed run is not green, even if its list of jobs came back without the
  // job that failed.
  const failed = [...verdict.failed, ...failedRuns(finished)];
  for (const line of verdict.lines) deps.out(line);
  if (verdict.passed && !failed.length) {
    deps.out(`ci:wait: every job passed on ${sha.slice(0, 7)}.`);
    return 0;
  }
  deps.out(`ci:wait: not green on ${sha.slice(0, 7)}: ${failed.join(", ")}`);
  return 1;
}

/** Everything before and after the wait: the refusals, the push, and the branch's removal. */
async function body(argv: string[], deps: CiWaitDeps): Promise<0 | 1 | 2> {
  let factory: ReturnType<typeof loadFactory>;
  try {
    factory = loadFactory();
  } catch (e) {
    deps.error(`ci:wait: couldn't read factory.json: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const args = parseCiWaitArgs(argv);
  if (!args || !factory.repos[args.repoKey]) {
    deps.error(`usage: npm run ci:wait -- <${Object.keys(factory.repos).join("|")}> [--timeout minutes]`);
    return 2;
  }
  const repo = repoConfig(factory, args.repoKey);
  // The config can be a file the caller chose (`FAULTFORGE_CONFIG`), so its `guard` alone is not trusted. The
  // guard's own list always holds the target, whatever a config says, and a config can only add to it.
  const guarded = reviewedRepos(process.env.FAULTFORGE_CONFIG).some(
    (reviewed) => reviewed.github.toLowerCase() === repo.github.toLowerCase(),
  );
  if (repo.guard === "reviewed" || guarded) {
    deps.error(
      `ci:wait: ${args.repoKey} is a reviewed repository. Nothing is pushed there outside the door, so its checks run on the pull request only.`,
    );
    return 2;
  }
  const required = repo.ciJobs ?? [];
  if (!required.length) {
    deps.error(
      `ci:wait: factory.json names no ciJobs for ${args.repoKey}, so it can't tell which checks must pass. Nothing was pushed.`,
    );
    return 2;
  }
  const checkout = resolve(ROOT, repo.path);
  const deadline = deps.now() + args.timeoutMinutes * 60_000;
  // From here to the verdict, nothing runs past the time limit: no git call and no read of GitHub, retries
  // included. Only removing the branch comes after it, with its own `GIT_TIMEOUT_MS`.
  callDeadline.at = Date.now() + (deadline - deps.now());
  let branch: string | undefined;
  let address = "";
  let pushed = false;
  let code: 0 | 1 | 2 | undefined;
  try {
    const read = readCheckout(checkout, repo.github, deps);
    if (read === null) return 2;
    const { sha } = read;
    // The push and the removal go to the address that was checked, never to whatever `origin` names by then.
    address = read.address;
    branch = scratchBranch(sha, deps.now(), deps.nonce());
    try {
      // Only the scratch branch: `push.followTags` in a config would send tags too, which no removal undoes.
      deps.git(checkout, "push", "--quiet", "--no-follow-tags", address, `${sha}:refs/heads/${branch}`);
      pushed = true;
    } catch (e) {
      deps.error(`ci:wait: couldn't push the scratch branch: ${e instanceof Error ? e.message : String(e)}`);
      code = 2;
    }
    if (pushed) {
      deps.out(`Pushed ${sha.slice(0, 7)} to ${branch}; waiting for its checks (up to ${args.timeoutMinutes} min)…`);
      code = await wait(args, repo.github, branch, sha, required, deadline, deps);
    }
  } catch (e) {
    deps.error(`ci:wait: couldn't read the checks: ${e instanceof Error ? e.message : String(e)}`);
    code = 2;
  } finally {
    callDeadline.at = undefined;
  }
  code ??= 2;
  if (branch === undefined) return code;
  // Whatever the result: a scratch branch left behind would be one more branch nobody owns. A push that
  // failed may still have made it, so it is removed then too.
  try {
    deps.git(checkout, "push", "--quiet", address, "--delete", branch);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    deps.error(
      pushed
        ? `ci:wait: couldn't delete ${branch}; delete it by hand: ${reason}`
        : `ci:wait: if ${branch} is on GitHub, the push made it after all; delete it by hand: ${reason}`,
    );
    if (code === 0) {
      // Exit 0 promises a checked commit and no branch left behind. This wait kept only half of that.
      deps.error("ci:wait: every job passed, but the scratch branch is still there, so this is not exit 0.");
      code = 2;
    }
  }
  return code;
}

/**
 * The commit to check and the address to push it to, or null after saying why there is none. The scratch
 * branch goes to `origin`'s push address, and the checks are read from the configured repository: they must be
 * one and the same, or the branch lands in a fork and the wait watches somewhere else. A remote can push to
 * other addresses than it fetches from, so every address it pushes to is checked too.
 */
function readCheckout(checkout: string, github: string, deps: CiWaitDeps): { sha: string; address: string } | null {
  try {
    const pushTo = deps.git(checkout, "remote", "get-url", "--push", "--all", "origin").split(/\r?\n/);
    const addresses = [...deps.git(checkout, "remote", "get-url", "--all", "origin").split(/\r?\n/), ...pushTo];
    // Git rewrites even an explicit address through `url.<base>.insteadOf` and `pushInsteadOf`, so with any
    // such rule the address checked here might not be where the push goes. The door refuses them the same way.
    let rewrites = "";
    try {
      rewrites = deps.git(checkout, "config", "--get-regexp", String.raw`^url\..*\.(insteadof|pushinsteadof)$`);
    } catch {
      // git exits 1 when no key matches: no rewrite.
    }
    if (rewrites.trim()) {
      deps.error("ci:wait: this checkout's git config rewrites remote addresses, so the push could go elsewhere.");
      return null;
    }
    if (!addresses.every((address) => remoteIs(address, github))) {
      deps.error(
        `ci:wait: this checkout's origin is not github.com/${github} for both fetching and pushing, so nothing was pushed.`,
      );
      return null;
    }
    if (deps.git(checkout, "status", "--porcelain")) {
      deps.error("ci:wait: there are uncommitted changes. It checks the commit, so commit first.");
      return null;
    }
    return { sha: deps.git(checkout, "rev-parse", "HEAD"), address: (pushTo[0] ?? "").trim() };
  } catch (e) {
    deps.error(`ci:wait: couldn't read the checkout: ${e instanceof Error ? e.message : String(e)}`);
    return null;
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

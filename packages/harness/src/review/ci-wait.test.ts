import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { githubRemote } from "../door/target-post-push.ts";
import { tempDir } from "../fixtures/temp-dir.ts";
import { callDeadline } from "../shared/github.ts";
import { ROOT } from "../shared/paths.ts";
import {
  type CiWaitDeps,
  GIT_TIMEOUT_MS,
  gitTimeout,
  type Job,
  jobsVerdict,
  ownRuns,
  parseCiWaitArgs,
  remoteIs,
  run,
  runsFinished,
  scratchBranch,
  type WorkflowRun,
} from "./ci-wait.ts";

const SHA = "a7439ecd94b508ca794789f933ad28cd5d596aa8";
const BRANCH = scratchBranch(SHA, 0, "n0");
const ORIGIN = "https://github.com/AJBeumer/faultforge.git";
const job = (name: string, conclusion: string | null, status = "completed"): Job => ({ name, status, conclusion });
// The jobs factory.json names for the lab: the fake world answers with these, as GitHub does.
const REQUIRED = [
  "npm run check",
  "npm run check (windows)",
  "npm run test:integration (ubuntu-latest)",
  "npm run test:integration (windows-latest)",
];
const GREEN = REQUIRED.map((name) => job(name, "success"));
const windowsRed = GREEN.map((j) => (j.name === "npm run check (windows)" ? job(j.name, "failure") : j));
const SKIPPED = [job("Alert on a red main", "skipped")];
const workflow = (id: number, extra: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  name: "Check",
  status: "completed",
  conclusion: "success",
  head_branch: BRANCH,
  head_sha: SHA,
  ...extra,
});

describe("parseCiWaitArgs", () => {
  it("takes a repo key and an optional time limit", () => {
    expect(parseCiWaitArgs(["faultforge"])).toEqual({ repoKey: "faultforge", timeoutMinutes: 25 });
    expect(parseCiWaitArgs(["faultforge", "--timeout", "9"])).toEqual({ repoKey: "faultforge", timeoutMinutes: 9 });
  });

  it("refuses anything else", () => {
    for (const argv of [[], ["a", "b"], ["x", "--timeout", "0"], ["x", "--timeout", "y"], ["x", "--other"]]) {
      expect(parseCiWaitArgs(argv)).toBeNull();
    }
  });
});

describe("jobsVerdict", () => {
  it("passes when every job succeeded or was skipped, and one really ran", () => {
    const verdict = jobsVerdict([...GREEN, ...SKIPPED], REQUIRED);
    expect(verdict.passed).toBe(true);
    expect(verdict.failed).toEqual([]);
    expect(verdict.lines).toContain("  npm run check (windows): success");
  });

  it("names the job that failed on one operating system alone", () => {
    const verdict = jobsVerdict(windowsRed, REQUIRED);
    expect(verdict.passed).toBe(false);
    expect(verdict.failed).toEqual(["npm run check (windows)"]);
  });

  it("doesn't pass a commit whose Windows job never ran, however many other jobs passed", () => {
    const linuxOnly = GREEN.filter((j) => !j.name.includes("windows"));
    const verdict = jobsVerdict([...linuxOnly, job("some other job", "success")], REQUIRED);
    expect(verdict.passed).toBe(false);
    expect(verdict.failed).toEqual([
      "npm run check (windows) (required, did not run)",
      "npm run test:integration (windows-latest) (required, did not run)",
    ]);
  });

  it("doesn't pass a required job that was skipped or ended neutral: it must have run", () => {
    for (const conclusion of ["skipped", "neutral"]) {
      const jobs = GREEN.map((j) => (j.name === "npm run check (windows)" ? job(j.name, conclusion) : j));
      expect(jobsVerdict(jobs, REQUIRED)).toMatchObject({
        passed: false,
        failed: ["npm run check (windows) (required, did not run)"],
      });
    }
  });

  it("still fails on a job nobody named, and names a failed required job once", () => {
    expect(jobsVerdict([...GREEN, job("a new job", "failure")], REQUIRED).failed).toEqual(["a new job"]);
    expect(jobsVerdict(windowsRed, REQUIRED).failed).toHaveLength(1);
  });

  it("doesn't pass a cancelled, timed-out or unfinished job, or a commit where no job ran", () => {
    expect(jobsVerdict([job("a", "cancelled")], ["a"]).passed).toBe(false);
    expect(jobsVerdict([job("a", "timed_out")], ["a"]).passed).toBe(false);
    expect(jobsVerdict([job("a", null, "in_progress")], ["a"]).failed).toEqual(["a"]);
    expect(jobsVerdict(SKIPPED, ["a"])).toMatchObject({ passed: false, failed: ["a (required, did not run)"] });
    expect(jobsVerdict([], ["a"]).passed).toBe(false);
  });

  it("passes nothing when no job is named as required", () => {
    expect(jobsVerdict(GREEN, []).passed).toBe(false);
  });
});

describe("which runs are a wait's own", () => {
  it("gives every wait a branch of its own, even two waits for one commit", () => {
    expect(scratchBranch(SHA, 1_000, "9f3a11c2")).toMatch(/^ci-wait\/a7439ecd94b5-[0-9a-z]+-9f3a11c2$/);
    expect(scratchBranch(SHA, 1_000, "a")).not.toBe(scratchBranch(SHA, 2_000, "a"));
    // Two waits for one commit in the same millisecond still differ, by what each drew at random.
    expect(scratchBranch(SHA, 1_000, "a")).not.toBe(scratchBranch(SHA, 1_000, "b"));
  });

  it("counts only runs of this wait's branch at this commit", () => {
    const runs = [
      workflow(1),
      workflow(2, { head_branch: "some-pr-branch" }),
      workflow(3, { head_branch: scratchBranch(SHA, 99, "n0") }),
      workflow(4, { head_sha: "b".repeat(40) }),
    ];
    expect(ownRuns(runs, BRANCH, SHA).map((r) => r.id)).toEqual([1]);
  });

  it("is finished only with at least one run, all completed", () => {
    expect(runsFinished([])).toBe(false);
    expect(runsFinished([workflow(1), workflow(2, { status: "in_progress" })])).toBe(false);
    expect(runsFinished([workflow(1)])).toBe(true);
  });
});

describe("remoteIs", () => {
  it("knows the configured repository by https or ssh, with or without .git, in any case", () => {
    for (const url of [
      "https://github.com/Owner/Lab.git",
      "https://github.com/owner/lab",
      "https://x-access-token@github.com/owner/lab.git",
      "git@github.com:owner/lab.git",
      "ssh://git@github.com/owner/lab",
      "ssh://git@ssh.github.com:443/owner/lab.git",
      "ssh://git@github.com:443/Owner/lab",
    ]) {
      expect(remoteIs(url, "owner/lab")).toBe(true);
    }
  });

  it("refuses a fork, another host, a local path and a look-alike", () => {
    for (const url of [
      "https://github.com/someone/lab.git",
      "https://example.com/owner/lab.git",
      "/srv/git/lab.git",
      "https://github.com/owner/lab-fork",
      "https://github.com.evil.example/owner/lab",
      "https://evil.example/github.com/owner/lab",
      "ssh://git@ssh.github.com:22/owner/lab.git",
      "https://github.com/owner/lab/extra",
    ]) {
      expect(remoteIs(url, "owner/lab")).toBe(false);
    }
  });

  it("takes exactly the addresses the door's reader takes, so the two copies can't drift apart unseen", () => {
    for (const url of [
      "https://github.com/Owner/Lab.git",
      "https://x-access-token@github.com/owner/lab.git",
      "git@github.com:owner/lab.git",
      "ssh://git@github.com/owner/lab",
      "ssh://git@ssh.github.com:443/owner/lab.git",
      "ssh://git@github.com:443/Owner/lab",
      "https://github.com/someone/lab.git",
      "https://example.com/owner/lab.git",
      "/srv/git/lab.git",
      "https://github.com.evil.example/owner/lab",
      "https://evil.example/github.com/owner/lab",
      "https://evil.example/x?https://github.com/owner/lab",
      "ssh://git@ssh.github.com:22/owner/lab.git",
      "https://github.com/owner/lab/extra",
    ]) {
      expect(remoteIs(url, "owner/lab"), url).toBe(githubRemote(url) === "owner/lab");
    }
  });
});

/** A fake world: scripted polls, a clock that moves when the command sleeps, and every git call recorded. */
function world(
  polls: { runs: WorkflowRun[]; jobs?: Job[]; fails?: string }[],
  options: {
    dirty?: boolean;
    pushFails?: boolean;
    deleteFails?: boolean;
    origin?: string;
    pushTo?: string;
    rewrites?: string;
  } = {},
) {
  const gitCalls: string[] = [];
  const out: string[] = [];
  const errors: string[] = [];
  let clock = 0;
  let poll = -1;
  const current = () => polls[Math.min(Math.max(poll, 0), polls.length - 1)];
  const deps: CiWaitDeps = {
    git: (_cwd, ...args) => {
      gitCalls.push(args.join(" "));
      const origin = options.origin ?? ORIGIN;
      if (args[0] === "remote") return args.includes("--push") ? (options.pushTo ?? origin) : origin;
      if (args[0] === "status") return options.dirty ? " M file.ts" : "";
      if (args[0] === "config") {
        // Like git: exit 1 when no key matches.
        if (!options.rewrites) throw new Error("exit 1");
        return options.rewrites;
      }
      if (args[0] === "rev-parse") return SHA;
      if (args[0] === "push" && !args.includes("--delete") && options.pushFails) throw new Error("rejected");
      if (args[0] === "push" && args.includes("--delete") && options.deleteFails) throw new Error("no such ref");
      return "";
    },
    runs: () => {
      poll++;
      const now = current();
      if (now?.fails) throw new Error(now.fails);
      return now?.runs ?? [];
    },
    jobs: () => current()?.jobs ?? [],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    nonce: () => "n0",
    out: (line) => out.push(line),
    error: (line) => errors.push(line),
  };
  return { deps, gitCalls, out: () => out.join("\n"), lastLine: () => out.at(-1), errors: () => errors.join("\n") };
}

describe("ci:wait", () => {
  it("pushes the commit to its own scratch branch, waits, passes, deletes the branch and names its exit code", async () => {
    const w = world([
      { runs: [] },
      { runs: [workflow(1, { status: "in_progress", conclusion: null })] },
      { runs: [workflow(1)], jobs: GREEN },
    ]);
    expect(await run(["faultforge"], w.deps)).toBe(0);
    expect(w.gitCalls).toContain(`push --quiet ${ORIGIN} ${SHA}:refs/heads/${BRANCH}`);
    expect(w.gitCalls.at(-1)).toBe(`push --quiet ${ORIGIN} --delete ${BRANCH}`);
    expect(w.out()).toContain("npm run check (windows): success");
    expect(w.out()).toContain("every job passed on a7439ec");
    expect(w.lastLine()).toBe("ci:wait exit 0");
  });

  it("exits 1 and names the job when Windows alone is red, and still deletes the branch", async () => {
    const w = world([{ runs: [workflow(1, { conclusion: "failure" })], jobs: windowsRed }]);
    expect(await run(["faultforge"], w.deps)).toBe(1);
    expect(w.out()).toContain("not green on a7439ec: npm run check (windows), the Check workflow (failure)\n");
    expect(w.gitCalls.at(-1)).toContain("--delete");
    expect(w.lastLine()).toBe("ci:wait exit 1");
  });

  it("exits 1, never 0, when a run failed but its list of jobs came back without the job that failed", async () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", null]) {
      const w = world([{ runs: [workflow(1), workflow(2, { name: "Extra", conclusion })], jobs: GREEN }]);
      expect(await run(["faultforge"], w.deps)).toBe(1);
      expect(w.out()).toContain(`not green on a7439ec: the Extra workflow (${conclusion ?? "no result"})`);
      expect(w.out()).not.toContain("every job passed");
    }
  });

  it("exits 1, never 0, when the Windows jobs the repository names did not run", async () => {
    const linuxOnly = GREEN.filter((j) => !j.name.includes("windows"));
    const w = world([{ runs: [workflow(1)], jobs: linuxOnly }]);
    expect(await run(["faultforge"], w.deps)).toBe(1);
    expect(w.out()).toContain("npm run check (windows) (required, did not run)");
    expect(w.lastLine()).toBe("ci:wait exit 1");
  });

  it("never takes an earlier, finished check of the same commit on another branch for its own", async () => {
    const earlier = workflow(7, { head_branch: "the-pr-branch" });
    const w = world([
      { runs: [earlier], jobs: GREEN },
      { runs: [earlier, workflow(8, { status: "in_progress", conclusion: null })], jobs: GREEN },
      { runs: [earlier, workflow(8, { conclusion: "failure" })], jobs: [job("npm run check (windows)", "failure")] },
    ]);
    expect(await run(["faultforge"], w.deps)).toBe(1);
  });

  it("pushes nothing when origin fetches from a second address that is another repository", async () => {
    const w = world([{ runs: [workflow(1)], jobs: GREEN }], {
      origin: `${ORIGIN}\nhttps://github.com/AJBeumer/faultforge-target.git`,
      pushTo: ORIGIN,
    });
    expect(await run(["faultforge"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(/for both fetching and pushing/);
    expect(w.gitCalls).toContain("remote get-url --all origin");
    expect(w.gitCalls.some((call) => call.startsWith("push"))).toBe(false);
  });

  it("pushes nothing when the checkout's git config rewrites remote addresses", async () => {
    for (const rewrites of [
      "url.https://github.com/someone/.insteadof https://github.com/AJBeumer/",
      "url.git@github.com:AJBeumer/faultforge-target.pushinsteadof https://github.com/AJBeumer/faultforge",
    ]) {
      const w = world([{ runs: [workflow(1)], jobs: GREEN }], { rewrites });
      expect(await run(["faultforge"], w.deps)).toBe(2);
      expect(w.errors()).toMatch(/rewrites remote addresses/);
      expect(w.gitCalls.some((call) => call.startsWith("push"))).toBe(false);
    }
  });

  it("names its exit code in its last line when factory.json can't be read", async () => {
    vi.stubEnv("FAULTFORGE_CONFIG", join(tempDir("ci-wait-no-config-"), "missing.json"));
    try {
      const w = world([]);
      expect(await run(["faultforge"], w.deps)).toBe(2);
      expect(w.errors()).toMatch(/couldn't read factory.json/);
      expect(w.lastLine()).toBe("ci:wait exit 2");
      expect(w.gitCalls).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("waits for a required job GitHub lists late, in the same run or in a later workflow", async () => {
    const linux = GREEN.filter((j) => !j.name.includes("windows"));
    // The run is listed and done, with the Linux jobs only, on two polls; the Windows jobs come after.
    const early = { runs: [workflow(1)], jobs: linux };
    const late = { runs: [workflow(1), workflow(2)], jobs: GREEN };
    const w = world([early, early, early, late, late]);
    expect(await run(["faultforge"], w.deps)).toBe(0);
    expect(w.out()).toContain("npm run check (windows): success");
  });

  it("waits for a job list that changed between two polls before it judges", async () => {
    const first = { runs: [workflow(1)], jobs: GREEN.slice(0, 3) };
    const second = { runs: [workflow(1)], jobs: GREEN };
    const w = world([first, second, second]);
    expect(await run(["faultforge"], w.deps)).toBe(0);
  });

  it("exits 1, never 2, for a workflow that failed before any job ran", async () => {
    const failedEarly = { runs: [workflow(1, { conclusion: "startup_failure" })], jobs: [] };
    const w = world([failedEarly, failedEarly]);
    expect(await run(["faultforge"], w.deps)).toBe(1);
    expect(w.out()).toContain("the Check workflow (startup_failure)");
    expect(w.errors()).not.toMatch(/ran no check/);
  });

  it("pushes to the push address it checked, and removes the branch there", async () => {
    const pushTo = "git@github.com:AJBeumer/faultforge.git";
    const w = world([{ runs: [workflow(1)], jobs: GREEN }], { pushTo });
    expect(await run(["faultforge"], w.deps)).toBe(0);
    expect(w.gitCalls).toContain(`push --quiet ${pushTo} ${SHA}:refs/heads/${BRANCH}`);
    expect(w.gitCalls.at(-1)).toBe(`push --quiet ${pushTo} --delete ${BRANCH}`);
    expect(w.gitCalls.some((call) => call.startsWith("push --quiet origin"))).toBe(false);
  });

  it("waits for a run GitHub lists a moment after the first one finished", async () => {
    const first = { runs: [workflow(1)], jobs: GREEN };
    const both = { runs: [workflow(1), workflow(2, { conclusion: "failure" })], jobs: [job("late job", "failure")] };
    const w = world([first, both]);
    expect(await run(["faultforge"], w.deps)).toBe(1);
    expect(w.out()).toContain("late job");
  });

  it("doesn't take a workflow that only skipped itself for the whole answer", async () => {
    const skippedOnly = { runs: [workflow(1, { name: "Alert", conclusion: "skipped" })], jobs: SKIPPED };
    const w = world([skippedOnly, skippedOnly, { runs: [workflow(1), workflow(2)], jobs: GREEN }]);
    expect(await run(["faultforge"], w.deps)).toBe(0);
  });

  it("exits 2 when no check ever runs for the commit", async () => {
    const w = world([{ runs: [] }]);
    expect(await run(["faultforge", "--timeout", "60"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(/ran no check for this commit/);
    expect(w.gitCalls.at(-1)).toContain("--delete");
    expect(w.lastLine()).toBe("ci:wait exit 2");
  });

  it("says GitHub could not be read, never that no check ran, when every poll fails", async () => {
    const w = world([{ runs: [], fails: "HTTP 401: Bad credentials" }]);
    expect(await run(["faultforge", "--timeout", "60"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(/GitHub could not be read.*HTTP 401/);
    expect(w.errors()).not.toMatch(/ran no check/);
  });

  it("says GitHub could not be read when the polls began to fail after one that found no run", async () => {
    const w = world([{ runs: [] }, { runs: [], fails: "HTTP 502: Bad gateway" }]);
    expect(await run(["faultforge", "--timeout", "60"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(/GitHub could not be read.*HTTP 502/);
    expect(w.errors()).not.toMatch(/ran no check/);
  });

  it("exits 2, never 0, when the checks don't finish in time", async () => {
    const w = world([{ runs: [workflow(1, { status: "in_progress", conclusion: null })] }]);
    expect(await run(["faultforge", "--timeout", "1"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(/didn't finish in 1 minutes/);
    expect(w.gitCalls.at(-1)).toContain("--delete");
  });

  it("refuses uncommitted changes: it checks the commit, not the working tree", async () => {
    const w = world([{ runs: [workflow(1)], jobs: GREEN }], { dirty: true });
    expect(await run(["faultforge"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(/commit first/);
    expect(w.gitCalls.some((call) => call.startsWith("push"))).toBe(false);
  });

  it("pushes nothing when the checkout's origin is a fork or another repository", async () => {
    const w = world([{ runs: [workflow(1)], jobs: GREEN }], { origin: "https://github.com/someone/faultforge.git" });
    expect(await run(["faultforge"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(/origin is not github.com\/AJBeumer\/faultforge/);
    expect(w.gitCalls.some((call) => call.startsWith("push"))).toBe(false);
  });

  it("refuses the reviewed repository even when a chosen config calls it a lab repository", async () => {
    // FAULTFORGE_CONFIG can name any file. One that relabels the target, with jobs to wait for, is still refused.
    const factory = JSON.parse(readFileSync(join(ROOT, "factory.json"), "utf8"));
    factory.repos.target = { ...factory.repos.target, guard: "lab", ciJobs: ["npm run check"] };
    const config = join(tempDir("ci-wait-config-"), "factory.json");
    writeFileSync(config, JSON.stringify(factory));
    vi.stubEnv("FAULTFORGE_CONFIG", config);
    try {
      const w = world([{ runs: [workflow(1)], jobs: GREEN }], {
        origin: "https://github.com/AJBeumer/faultforge-target.git",
      });
      expect(await run(["target"], w.deps)).toBe(2);
      expect(w.errors()).toMatch(/reviewed repository/);
      expect(w.gitCalls).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses a reviewed repository, and makes no git call there", async () => {
    const w = world([{ runs: [workflow(1)], jobs: GREEN }]);
    expect(await run(["target"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(/reviewed repository/);
    expect(w.gitCalls).toEqual([]);
    expect(w.lastLine()).toBe("ci:wait exit 2");
  });

  it("pushes nothing when origin fetches from the repository but pushes somewhere else", async () => {
    for (const pushTo of [
      "https://github.com/someone/faultforge.git",
      "https://github.com/AJBeumer/faultforge.git\ngit@github.com:AJBeumer/faultforge-target.git",
    ]) {
      const w = world([{ runs: [workflow(1)], jobs: GREEN }], { pushTo });
      expect(await run(["faultforge"], w.deps)).toBe(2);
      expect(w.errors()).toMatch(/for both fetching and pushing/);
      expect(w.gitCalls.some((call) => call.startsWith("push"))).toBe(false);
    }
  });

  it("exits 2 for a bad argument, and makes no git call", async () => {
    for (const argv of [[], ["nowhere"]]) {
      const w = world([]);
      expect(await run(argv, w.deps)).toBe(2);
      expect(w.gitCalls).toEqual([]);
    }
  });

  it("exits 2 when the push fails, and still removes a branch the failed push may have made", async () => {
    const w = world([], { pushFails: true, deleteFails: true });
    expect(await run(["faultforge"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(/couldn't push the scratch branch: rejected/);
    expect(w.gitCalls.at(-1)).toBe(`push --quiet ${ORIGIN} --delete ${BRANCH}`);
    // The branch may be there after all: its name is given, so it can be removed by hand.
    expect(w.errors()).toMatch(new RegExp(`if ${BRANCH} is on GitHub, the push made it after all; delete it by hand`));
  });

  it("says nothing more after a failed push when the branch it may have made was removed", async () => {
    const w = world([], { pushFails: true });
    expect(await run(["faultforge"], w.deps)).toBe(2);
    expect(w.gitCalls.at(-1)).toBe(`push --quiet ${ORIGIN} --delete ${BRANCH}`);
    expect(w.errors()).not.toMatch(/delete it by hand/);
  });

  it("exits 2, never 0, when every job passed but the scratch branch could not be deleted", async () => {
    const w = world([{ runs: [workflow(1)], jobs: GREEN }], { deleteFails: true });
    expect(await run(["faultforge"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(new RegExp(`couldn't delete ${BRANCH}; delete it by hand`));
    expect(w.errors()).toMatch(/every job passed, but the scratch branch is still there/);
    expect(w.lastLine()).toBe("ci:wait exit 2");
  });

  it("keeps exit 1 when a job failed and the scratch branch could not be deleted either", async () => {
    const w = world([{ runs: [workflow(1, { conclusion: "failure" })], jobs: windowsRed }], { deleteFails: true });
    expect(await run(["faultforge"], w.deps)).toBe(1);
    expect(w.errors()).toMatch(/delete it by hand/);
  });

  it("counts the time limit from the command's start, and gives it to every read of GitHub while it waits", async () => {
    const w = world([{ runs: [workflow(1)], jobs: GREEN }]);
    const seen: (number | undefined)[] = [];
    const runs = w.deps.runs;
    const before = Date.now();
    w.deps.runs = (github, branch) => {
      seen.push(callDeadline.at);
      return runs(github, branch);
    };
    expect(await run(["faultforge", "--timeout", "9"], w.deps)).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    for (const at of seen) {
      expect(at).toBeGreaterThanOrEqual(before + 9 * 60_000);
      expect(at).toBeLessThanOrEqual(Date.now() + 9 * 60_000);
    }
    // And it is taken off again, whatever the result: the next command in this process has its own.
    expect(callDeadline.at).toBeUndefined();
    const failing = world([{ runs: [], fails: "HTTP 500" }]);
    expect(await run(["faultforge", "--timeout", "1"], failing.deps)).toBe(2);
    expect(callDeadline.at).toBeUndefined();
  });

  it("gives a git call less time than the Bash tool leaves after the wait's nine minutes", () => {
    expect(9 * 60_000 + GIT_TIMEOUT_MS).toBeLessThan(600_000);
  });

  it("cuts a git call's time to what is left before the limit, and never below a second", () => {
    expect(gitTimeout(0, undefined)).toBe(GIT_TIMEOUT_MS);
    expect(gitTimeout(0, 10 * 60_000)).toBe(GIT_TIMEOUT_MS);
    expect(gitTimeout(0, 5_000)).toBe(5_000);
    expect(gitTimeout(10_000, 5_000)).toBe(1_000);
  });

  it("reads the checkout and pushes within the time limit, and removes the branch after it with its own", async () => {
    const w = world([{ runs: [workflow(1)], jobs: GREEN }]);
    const limits = new Map<string, number | undefined>();
    const git = w.deps.git;
    w.deps.git = (cwd, ...args) => {
      const name = args[0] === "push" ? (args.includes("--delete") ? "remove" : "push") : (args[0] ?? "");
      limits.set(name, callDeadline.at);
      return git(cwd, ...args);
    };
    expect(await run(["faultforge", "--timeout", "1"], w.deps)).toBe(0);
    for (const name of ["remote", "status", "rev-parse", "push"]) expect(limits.get(name)).toBeDefined();
    expect(limits.get("remove")).toBeUndefined();
  });

  it("takes the time limit off again when it refuses before pushing", async () => {
    const w = world([], { dirty: true });
    expect(await run(["faultforge"], w.deps)).toBe(2);
    expect(callDeadline.at).toBeUndefined();
  });

  it("removes the branch with a time of its own when the push itself failed at the limit", async () => {
    const w = world([], { pushFails: true });
    let removeLimit: number | undefined = -1;
    const git = w.deps.git;
    w.deps.git = (cwd, ...args) => {
      if (args.includes("--delete")) removeLimit = callDeadline.at;
      return git(cwd, ...args);
    };
    expect(await run(["faultforge"], w.deps)).toBe(2);
    expect(removeLimit).toBeUndefined();
    expect(callDeadline.at).toBeUndefined();
  });
});

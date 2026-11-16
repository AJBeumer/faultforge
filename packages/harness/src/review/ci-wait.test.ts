import { describe, expect, it } from "vitest";
import {
  type CiWaitDeps,
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
const BRANCH = scratchBranch(SHA, 0);
const job = (name: string, conclusion: string | null, status = "completed"): Job => ({ name, status, conclusion });
const GREEN = [job("npm run check", "success"), job("npm run check (windows)", "success")];
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
    const verdict = jobsVerdict([...GREEN, ...SKIPPED]);
    expect(verdict.passed).toBe(true);
    expect(verdict.failed).toEqual([]);
    expect(verdict.lines).toContain("  npm run check (windows): success");
  });

  it("names the job that failed on one operating system alone", () => {
    const verdict = jobsVerdict([job("npm run check", "success"), job("npm run check (windows)", "failure")]);
    expect(verdict.passed).toBe(false);
    expect(verdict.failed).toEqual(["npm run check (windows)"]);
  });

  it("doesn't pass a cancelled, timed-out or unfinished job, or a commit where no job ran", () => {
    expect(jobsVerdict([job("a", "cancelled")]).passed).toBe(false);
    expect(jobsVerdict([job("a", "timed_out")]).passed).toBe(false);
    expect(jobsVerdict([job("a", null, "in_progress")]).failed).toEqual(["a"]);
    expect(jobsVerdict(SKIPPED)).toMatchObject({ passed: false, failed: ["(no job ran)"] });
    expect(jobsVerdict([]).passed).toBe(false);
  });
});

describe("which runs are a wait's own", () => {
  it("gives every wait a branch of its own, even two waits for one commit", () => {
    expect(scratchBranch(SHA, 1_000)).toMatch(/^ci-wait\/a7439ecd94b5-[0-9a-z]+$/);
    expect(scratchBranch(SHA, 1_000)).not.toBe(scratchBranch(SHA, 2_000));
  });

  it("counts only runs of this wait's branch at this commit", () => {
    const runs = [
      workflow(1),
      workflow(2, { head_branch: "some-pr-branch" }),
      workflow(3, { head_branch: scratchBranch(SHA, 99) }),
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
    ]) {
      expect(remoteIs(url, "owner/lab")).toBe(false);
    }
  });
});

/** A fake world: scripted polls, a clock that moves when the command sleeps, and every git call recorded. */
function world(
  polls: { runs: WorkflowRun[]; jobs?: Job[]; fails?: string }[],
  options: { dirty?: boolean; pushFails?: boolean; origin?: string } = {},
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
      if (args[0] === "remote") return options.origin ?? "https://github.com/AJBeumer/faultforge.git";
      if (args[0] === "status") return options.dirty ? " M file.ts" : "";
      if (args[0] === "rev-parse") return SHA;
      if (args[0] === "push" && !args.includes("--delete") && options.pushFails) throw new Error("rejected");
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
    expect(w.gitCalls).toContain(`push --quiet origin ${SHA}:refs/heads/${BRANCH}`);
    expect(w.gitCalls.at(-1)).toBe(`push --quiet origin --delete ${BRANCH}`);
    expect(w.out()).toContain("npm run check (windows): success");
    expect(w.out()).toContain("every job passed on a7439ec");
    expect(w.lastLine()).toBe("ci:wait exit 0");
  });

  it("exits 1 and names the job when Windows alone is red, and still deletes the branch", async () => {
    const jobs = [job("npm run check", "success"), job("npm run check (windows)", "failure")];
    const w = world([{ runs: [workflow(1, { conclusion: "failure" })], jobs }]);
    expect(await run(["faultforge"], w.deps)).toBe(1);
    expect(w.out()).toContain("not green on a7439ec: npm run check (windows)");
    expect(w.gitCalls.at(-1)).toContain("--delete");
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

  it("refuses a reviewed repository, and makes no git call there", async () => {
    const w = world([{ runs: [workflow(1)], jobs: GREEN }]);
    expect(await run(["target"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(/reviewed repository/);
    expect(w.gitCalls).toEqual([]);
    expect(w.lastLine()).toBe("ci:wait exit 2");
  });

  it("exits 2 for a bad argument or a push that fails, and deletes nothing it didn't push", async () => {
    expect(await run([], world([]).deps)).toBe(2);
    expect(await run(["nowhere"], world([]).deps)).toBe(2);
    const w = world([], { pushFails: true });
    expect(await run(["faultforge"], w.deps)).toBe(2);
    expect(w.gitCalls.some((call) => call.includes("--delete"))).toBe(false);
  });
});

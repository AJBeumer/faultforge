import { describe, expect, it } from "vitest";
import {
  type CiWaitDeps,
  type Job,
  jobsVerdict,
  parseCiWaitArgs,
  run,
  runsFinished,
  START_LIMIT_MS,
  scratchBranch,
  type WorkflowRun,
} from "./ci-wait.ts";

const SHA = "a7439ecd94b508ca794789f933ad28cd5d596aa8";
const job = (name: string, conclusion: string | null, status = "completed"): Job => ({ name, status, conclusion });
const GREEN = [
  job("npm run check", "success"),
  job("npm run check (windows)", "success"),
  job("Alert on a red main", "skipped"),
];
const done: WorkflowRun = { name: "Check", status: "completed", conclusion: "success" };

describe("parseCiWaitArgs", () => {
  it("takes a repo key and an optional time limit", () => {
    expect(parseCiWaitArgs(["faultforge"])).toEqual({ repoKey: "faultforge", timeoutMinutes: 25 });
    expect(parseCiWaitArgs(["faultforge", "--timeout", "30"])).toEqual({ repoKey: "faultforge", timeoutMinutes: 30 });
  });

  it("refuses anything else", () => {
    for (const argv of [
      [],
      ["a", "b"],
      ["faultforge", "--timeout", "0"],
      ["faultforge", "--timeout", "x"],
      ["faultforge", "--other"],
    ]) {
      expect(parseCiWaitArgs(argv)).toBeNull();
    }
  });
});

describe("jobsVerdict", () => {
  it("passes when every job succeeded or was skipped, and one really ran", () => {
    const verdict = jobsVerdict(GREEN);
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
    expect(jobsVerdict([job("a", "skipped")])).toMatchObject({ passed: false, failed: ["(no job ran)"] });
    expect(jobsVerdict([]).passed).toBe(false);
  });
});

describe("runsFinished and scratchBranch", () => {
  it("is finished only with at least one run, all completed", () => {
    expect(runsFinished([])).toBe(false);
    expect(runsFinished([done, { ...done, status: "in_progress" }])).toBe(false);
    expect(runsFinished([done])).toBe(true);
  });

  it("names the scratch branch by the commit", () => {
    expect(scratchBranch(SHA)).toBe("ci-wait/a7439ecd94b5");
  });
});

/** A fake world: scripted polls, a clock that moves when the command sleeps, and every git call recorded. */
function world(polls: { runs: WorkflowRun[]; jobs: Job[] }[], options: { dirty?: boolean; pushFails?: boolean } = {}) {
  const gitCalls: string[] = [];
  const out: string[] = [];
  const errors: string[] = [];
  let clock = 0;
  let poll = -1;
  const deps: CiWaitDeps = {
    git: (_cwd, ...args) => {
      gitCalls.push(args.join(" "));
      if (args[0] === "status") return options.dirty ? " M file.ts" : "";
      if (args[0] === "rev-parse") return SHA;
      if (args[0] === "push" && !args.includes("--delete") && options.pushFails) throw new Error("rejected");
      return "";
    },
    runs: () => {
      poll = Math.min(poll + 1, polls.length - 1);
      return polls[poll]?.runs ?? [];
    },
    jobs: () => polls[Math.max(poll, 0)]?.jobs ?? [],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    out: (line) => out.push(line),
    error: (line) => errors.push(line),
  };
  return { deps, gitCalls, out: () => out.join("\n"), errors: () => errors.join("\n") };
}

describe("ci:wait", () => {
  it("pushes the commit to a scratch branch, waits, passes, and deletes the branch", async () => {
    const w = world([
      { runs: [], jobs: [] },
      { runs: [{ ...done, status: "in_progress", conclusion: null }], jobs: [] },
      { runs: [done], jobs: GREEN },
    ]);
    expect(await run(["faultforge"], w.deps)).toBe(0);
    expect(w.gitCalls).toContain(`push --quiet origin ${SHA}:refs/heads/ci-wait/a7439ecd94b5`);
    expect(w.gitCalls.at(-1)).toBe("push --quiet origin --delete ci-wait/a7439ecd94b5");
    expect(w.out()).toContain("npm run check (windows): success");
    expect(w.out()).toContain("every job passed on a7439ec");
  });

  it("exits 1 and names the job when Windows alone is red, and still deletes the branch", async () => {
    const jobs = [job("npm run check", "success"), job("npm run check (windows)", "failure")];
    const w = world([{ runs: [{ ...done, conclusion: "failure" }], jobs }]);
    expect(await run(["faultforge"], w.deps)).toBe(1);
    expect(w.out()).toContain("not green on a7439ec: npm run check (windows)");
    expect(w.gitCalls.at(-1)).toContain("--delete");
  });

  it("doesn't take a workflow that only skipped itself for the whole answer", async () => {
    const skippedOnly = {
      runs: [{ name: "Alert", status: "completed", conclusion: "skipped" }],
      jobs: [job("Alert", "skipped")],
    };
    const w = world([skippedOnly, skippedOnly, { runs: [done], jobs: GREEN }]);
    expect(await run(["faultforge"], w.deps)).toBe(0);
  });

  it("exits 2 when no check ever runs for the commit", async () => {
    const w = world([{ runs: [], jobs: [] }]);
    expect(await run(["faultforge", "--timeout", "60"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(/ran no check for this commit/);
    expect(START_LIMIT_MS).toBeLessThan(60 * 60_000);
    expect(w.gitCalls.at(-1)).toContain("--delete");
  });

  it("exits 2, never 0, when the checks don't finish in time", async () => {
    const w = world([{ runs: [{ ...done, status: "in_progress", conclusion: null }], jobs: [] }]);
    expect(await run(["faultforge", "--timeout", "1"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(/didn't finish in 1 minutes/);
  });

  it("refuses uncommitted changes: it checks the commit, not the working tree", async () => {
    const w = world([{ runs: [done], jobs: GREEN }], { dirty: true });
    expect(await run(["faultforge"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(/commit first/);
    expect(w.gitCalls.some((call) => call.startsWith("push"))).toBe(false);
  });

  it("refuses a reviewed repository, and pushes nothing there", async () => {
    const w = world([{ runs: [done], jobs: GREEN }]);
    expect(await run(["target"], w.deps)).toBe(2);
    expect(w.errors()).toMatch(/reviewed repository/);
    expect(w.gitCalls).toEqual([]);
  });

  it("exits 2 for a bad argument or a push that fails, and deletes nothing it didn't push", async () => {
    expect(await run([], world([]).deps)).toBe(2);
    expect(await run(["nowhere"], world([]).deps)).toBe(2);
    const w = world([], { pushFails: true });
    expect(await run(["faultforge"], w.deps)).toBe(2);
    expect(w.gitCalls.some((call) => call.includes("--delete"))).toBe(false);
  });
});

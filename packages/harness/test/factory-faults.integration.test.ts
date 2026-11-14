/**
 * Fault injection for the factory's recovery (#308): `factory-relabel.ts` and `factory-recovery.ts` run against a
 * fake GitHub that fails at chosen points, and the tick's lock against a holder that really died. After each
 * fault the ticket must be in a state a later tick or the owner finds (a factory label is still on it), and a
 * recovery must then put it right. Never real GitHub: every issue, label and comment lives in memory here.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFactory } from "../src/factory-config.ts";
import { finishRun } from "../src/factory-finish.ts";
import { acquireLock, beatFile } from "../src/factory-lock.ts";
import { type RecoveryDeps, recoverStranded, STRANDED_COMMENT } from "../src/factory-recovery.ts";
import { relabelWith } from "../src/factory-relabel.ts";
import { LABELS } from "../src/factory-settle.ts";
import type { TickDeps, Workspace } from "../src/factory-tick-deps.ts";
import { ExternalCallError } from "../src/github.ts";

const REPO = "owner/app";
const FACTORY_LABELS: string[] = Object.values(LABELS);

type Op = "add" | "remove" | "comment" | "list";

/** One planned failure: the call it hits, and whether GitHub applied the change before the call failed. */
interface Fault {
  op: Op;
  label?: string;
  applied?: boolean;
}

/** A GitHub with one repo's issues in memory, failing each planned call once. */
class FakeGitHub {
  readonly labels = new Map<number, Set<string>>();
  readonly comments = new Map<number, string[]>();
  readonly calls: string[] = [];
  private faults: Fault[] = [];

  open(number: number, ...labels: string[]) {
    this.labels.set(number, new Set(labels));
    this.comments.set(number, []);
  }

  failNext(fault: Fault) {
    this.faults.push(fault);
  }

  private fault(op: Op, label?: string): Fault | undefined {
    const i = this.faults.findIndex((f) => f.op === op && (!f.label || f.label === label));
    return i < 0 ? undefined : this.faults.splice(i, 1)[0];
  }

  private static error(label: string, stderr: string): ExternalCallError {
    return new ExternalCallError(label, Object.assign(new Error(stderr), { stderr }));
  }

  addLabels(number: number, labels: string[]) {
    this.calls.push(`add ${labels.join(",")}`);
    const fault = this.fault("add", labels[0]);
    if (fault && !fault.applied) throw FakeGitHub.error("gh issue edit", "HTTP 502: Bad Gateway");
    for (const label of labels) this.labels.get(number)?.add(label);
    if (fault) throw FakeGitHub.error("gh issue edit", "HTTP 504: the request timed out after the change");
  }

  removeLabel(number: number, label: string) {
    this.calls.push(`remove ${label}`);
    const fault = this.fault("remove", label);
    if (fault && !fault.applied) throw FakeGitHub.error("gh api", "HTTP 500: Internal Server Error");
    const had = this.labels.get(number)?.delete(label);
    if (!had) throw FakeGitHub.error("gh api", "HTTP 404: Label does not exist");
    if (fault) throw FakeGitHub.error("gh api", "HTTP 504: the request timed out after the change");
  }

  comment(number: number, body: string) {
    this.calls.push("comment");
    if (this.fault("comment")) throw FakeGitHub.error("gh issue comment", "HTTP 502: Bad Gateway");
    this.comments.get(number)?.push(body);
  }

  labelled(label: string): { number: number; title: string }[] {
    if (this.fault("list", label)) throw FakeGitHub.error("gh api", "HTTP 503: Service Unavailable");
    return [...this.labels].filter(([, set]) => set.has(label)).map(([number]) => ({ number, title: `#${number}` }));
  }

  /** The factory labels on the ticket, sorted. */
  state(number: number): string[] {
    return [...(this.labels.get(number) ?? [])].filter((l) => FACTORY_LABELS.includes(l)).sort();
  }

  /** The runner's relabel, as factory-deps.ts wires it: an add through `gh issue edit`, a removal per label. */
  relabel(number: number, remove: string[], add: string[]) {
    return relabelWith(
      remove,
      add,
      (label) => this.removeLabel(number, label),
      (labels) => this.addLabels(number, labels),
    );
  }

  /** Recovery's dependencies on this fake, for a tick of `mode` that finds every claim made the same way. */
  deps(): RecoveryDeps {
    return {
      labelled: (_github, label) => this.labelled(label),
      relabel: (_github, number, remove, add) => this.relabel(number, remove, add),
      comment: (_github, number, body) => this.comment(number, body),
      claimMode: () => "ci",
      mode: "ci",
    };
  }
}

/** A later tick or the owner can find the ticket: a factory label is still on it. */
function findable(github: FakeGitHub, number: number): boolean {
  return github.state(number).length > 0;
}

/** Recovery, run until nothing fails (at most three ticks), as successive ticks would run it. */
function recoverUntilClean(github: FakeGitHub) {
  for (let tick = 0; tick < 3; tick++) {
    const report = recoverStranded([{ github: REPO }], github.deps());
    if (!report.failed.length) return report;
  }
  throw new Error("recovery still failing after three ticks");
}

describe("a relabel never leaves a ticket with no factory label (#308)", () => {
  it.each([
    ["the add fails outright", { op: "add", label: LABELS.help } as Fault, [LABELS.working]],
    [
      "the add is applied but its call fails",
      { op: "add", label: LABELS.help, applied: true } as Fault,
      [LABELS.help, LABELS.working],
    ],
  ])("%s: nothing is removed after it, and recovery ends at agent-needs-help", (_name, fault, after) => {
    const github = new FakeGitHub();
    github.open(1, LABELS.working);
    github.failNext(fault);
    const problems = github.relabel(1, [LABELS.working, LABELS.ready], [LABELS.help]);
    expect(problems.addFailed).toBeTruthy();
    // No removal ran after the failed add, so the old label is still on.
    expect(github.calls).toEqual([`add ${LABELS.help}`]);
    expect(github.state(1)).toEqual(after);
    expect(findable(github, 1)).toBe(true);
    recoverUntilClean(github);
    expect(github.state(1)).toEqual([LABELS.help]);
  });

  it("a removal that fails after a good add leaves both labels, and recovery removes the old one without a second comment", () => {
    const github = new FakeGitHub();
    github.open(2, LABELS.working);
    github.failNext({ op: "remove", label: LABELS.working });
    const problems = github.relabel(2, [LABELS.working, LABELS.ready], [LABELS.done]);
    expect(problems.removeFailed).toBeTruthy();
    expect(github.state(2)).toEqual([LABELS.done, LABELS.working]);
    const report = recoverUntilClean(github);
    expect(report.recovered).toEqual([`${REPO}#2`]);
    expect(github.state(2)).toEqual([LABELS.done]);
    expect(github.comments.get(2)).toEqual([]);
  });

  it("a removal GitHub applied before its call failed is reported, and leaves the new label alone", () => {
    const github = new FakeGitHub();
    github.open(3, LABELS.working);
    github.failNext({ op: "remove", label: LABELS.working, applied: true });
    const problems = github.relabel(3, [LABELS.working, LABELS.ready], [LABELS.done]);
    // A timeout is never taken for "already gone": it is reported.
    expect(problems.removeFailed).toBeTruthy();
    expect(github.state(3)).toEqual([LABELS.done]);
    expect(recoverUntilClean(github).recovered).toEqual([]);
    expect(github.state(3)).toEqual([LABELS.done]);
  });

  it("a label that is already gone counts as removed", () => {
    const github = new FakeGitHub();
    github.open(8, LABELS.working);
    const problems = github.relabel(8, [LABELS.working, LABELS.ready], [LABELS.help]);
    expect(problems).toEqual({ removeFailed: null, addFailed: null });
    expect(github.state(8)).toEqual([LABELS.help]);
  });
});

describe("a stranded agent-working ticket is recovered whatever step fails (#308)", () => {
  it.each([
    ["listing the tickets", { op: "list", label: LABELS.working } as Fault, 1],
    ["the comment", { op: "comment" } as Fault, 1],
    ["adding agent-needs-help", { op: "add", label: LABELS.help } as Fault, 2],
    [
      "adding agent-needs-help, applied but reported failed",
      { op: "add", label: LABELS.help, applied: true } as Fault,
      1,
    ],
    ["removing agent-working", { op: "remove", label: LABELS.working } as Fault, 1],
  ])("when %s fails, it stays findable, and the next tick puts it right", (_name, fault, comments) => {
    const github = new FakeGitHub();
    github.open(4, LABELS.working);
    github.failNext(fault);
    const first = recoverStranded([{ github: REPO }], github.deps());
    expect(first.failed).toHaveLength(1);
    expect(github.state(4)).toContain(LABELS.working);
    const second = recoverStranded([{ github: REPO }], github.deps());
    expect(second.failed).toEqual([]);
    expect(github.state(4)).toEqual([LABELS.help]);
    // At most one comment per tick that reached it; a ticket that already shows its result gets none more.
    expect(github.comments.get(4)).toEqual(Array(comments).fill(STRANDED_COMMENT));
  });

  it("leaves a ticket another way of running claimed, untouched and findable", () => {
    const github = new FakeGitHub();
    github.open(5, LABELS.working);
    const report = recoverStranded([{ github: REPO }], { ...github.deps(), claimMode: () => "local" });
    expect(report.otherMode).toHaveLength(1);
    expect(github.state(5)).toEqual([LABELS.working]);
  });
});

/** A pid that belonged to a process that has now exited: a holder that really died. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

describe("a lock whose holder died (#308)", () => {
  it("is taken over by the next tick, which then recovers the ticket the dead run left working", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-faults-lock-"));
    const token = "dead-holder";
    writeFileSync(
      join(dir, "factory.lock"),
      JSON.stringify({ pid: deadPid(), since: "2026-11-14T00:00:00Z", at: "2026-11-14T00:00:00Z", token }),
    );
    writeFileSync(beatFile(dir, token), JSON.stringify({ at: "2026-11-14T00:01:00Z" }));
    const lock = acquireLock(dir);
    try {
      expect(lock.acquired).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "factory.lock"), "utf8")).pid).toBe(process.pid);
      expect(existsSync(beatFile(dir, token))).toBe(false);
      const github = new FakeGitHub();
      github.open(6, LABELS.working);
      recoverUntilClean(github);
      expect(github.state(6)).toEqual([LABELS.help]);
    } finally {
      lock.release();
    }
    expect(existsSync(join(dir, "factory.lock"))).toBe(false);
  });

  it("ends the dead holder's agent, still running, before it takes the lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-faults-agent-"));
    const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const token = "dead-with-agent";
    writeFileSync(join(dir, "factory.lock"), JSON.stringify({ pid: deadPid(), since: "x", at: "x", token }));
    writeFileSync(beatFile(dir, token), JSON.stringify({ at: "x", agentPid: live.pid, agentStarted: "start-1" }));
    const killed: number[] = [];
    const lock = acquireLock(dir, undefined, {
      startIdOf: () => "start-1",
      killAgent: (pid) => {
        killed.push(pid);
        process.kill(pid);
      },
    });
    try {
      expect(lock.acquired).toBe(true);
      expect(killed).toEqual([live.pid]);
    } finally {
      lock.release();
      live.kill();
    }
  });
});

describe("a crash between saving evidence and labelling (#308)", () => {
  it("leaves the evidence saved and the ticket working, and recovery moves it to agent-needs-help", () => {
    const github = new FakeGitHub();
    github.open(7, LABELS.working);
    const saved: string[] = [];
    const deps = {
      saveEvidence: (runId: string) => {
        saved.push(runId);
        return { pushed: true, blocked: [], file: `factory-runs/${runId}.jsonl` };
      },
      cleanup: () => {},
    } as unknown as TickDeps;
    const ws = { root: join(tmpdir(), "run"), lab: "", private: "" } as unknown as Workspace;
    // The process dies at the relabel: nothing after the save runs.
    const crash = new Error("killed");
    expect(() =>
      finishRun({
        factory: loadFactory(),
        deps,
        runId: "r-crash",
        ws,
        finish: { label: LABELS.done, reason: "a PR is open", pr: null },
        log: () => {},
        relabel: () => {
          throw crash;
        },
        say: () => {},
        reviewed: false,
        labelled: () => {},
        finished: () => {},
      }),
    ).toThrow(crash);
    expect(saved).toEqual(["r-crash"]);
    expect(github.state(7)).toEqual([LABELS.working]);
    expect(findable(github, 7)).toBe(true);
    const report = recoverUntilClean(github);
    expect(report.recovered).toEqual([`${REPO}#7`]);
    expect(github.state(7)).toEqual([LABELS.help]);
    expect(github.comments.get(7)).toEqual([STRANDED_COMMENT]);
  });
});

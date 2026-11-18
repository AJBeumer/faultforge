import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../fixtures/temp-dir.ts";
import type { FactoryConfig, QualityGate } from "../shared/factory-config.ts";
import { diagramDoc, main, mermaid, readRuns, runStats } from "./factory-diagram.ts";

// Event shapes mirror the real run logs under private/raw-artifacts/factory-runs/, which aren't committed
// to this repo (.gitignore excludes private/) and so can't be read in tests.

const ev = (event: string, extra: Record<string, unknown> = {}) => ({ t: "2026-11-10T10:00:00Z", event, ...extra });
const step = (name: string, error = false) => ev("agent-step-result", { step: name, error });

const doneRun = [
  ev("picked", { repo: "faultforge", ticket: 1 }),
  ev("claimed"),
  ev("qodo-checked", { exitCode: 0 }),
  ev("hooks-checked", { ok: true }),
  ev("clarified", { result: "no open questions" }),
  ev("agent-started"),
  step("check", true),
  step("check"),
  step("ci-wait"),
  step("push"),
  step("pr-opened"),
  step("review-wait"),
  step("review-wait"),
  step("revert-check"),
  ev("agent-finished", { result: { outcome: "ready", reason: "ready" } }),
  ev("audited", { problems: [] }),
  ev("verified", { problems: [] }),
  ev("finished", { label: "agent-done", reason: "the pull request is ready for the owner to merge" }),
];

const stuckRun = [
  ev("picked", { repo: "faultforge", ticket: 2 }),
  ev("claimed"),
  ev("qodo-checked", { exitCode: 0 }),
  ev("agent-started"),
  step("check"),
  step("pr-opened"),
  step("review-wait"),
  step("review-wait"),
  step("review-wait+ci-wait+push"),
  ev("agent-finished", { result: { outcome: "stuck", reason: "Three review rounds | one finding open" } }),
  ev("audited", { problems: [] }),
  ev("finished", { label: "agent-needs-help", reason: "the agent reported stuck" }),
];

const notReadyRun = [
  { ...ev("picked", { repo: "faultforge", ticket: 3 }), t: "2026-11-09T08:00:00Z" },
  ev("not-ready", { problems: ['missing section "Done when"'] }),
];

const gate: QualityGate = {
  fix: ["action_required", "remediation_recommended"],
  flag: ["informational"],
  maxRounds: 3,
};
const config = {
  evidence: "private/raw-artifacts",
  gate,
  repos: { faultforge: { ciJobs: ["npm run check", "npm run check (windows)"] } },
} as unknown as FactoryConfig;

const runs = [
  { id: "20261110-100000-faultforge-1", events: doneRun },
  { id: "20261110-110000-faultforge-2", events: stuckRun },
  { id: "20261109-080000-faultforge-3", events: notReadyRun },
];

const jsonl = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

describe("runStats", () => {
  it("counts each step of three known runs", () => {
    const s = runStats(runs);
    expect(s).toMatchObject({
      runs: 3,
      first: "2026-11-09T08:00:00Z",
      refused: 0,
      notReady: 1,
      claimed: 2,
      preflightFailed: 0,
      clarified: 1,
      questions: 0,
      built: 2,
      checkFailures: 1,
      ciWaitRuns: 2,
      prRuns: 2,
      reviewRuns: 2,
      reReviews: 3,
      revertRuns: 1,
      agentReady: 1,
      agentStuck: 1,
      agentNoResult: 0,
      auditProblems: 0,
      verified: 1,
      verifyProblems: 0,
      done: 1,
    });
    expect(s.stops.map((x) => [x.id, x.where])).toEqual([
      ["20261110-110000-faultforge-2", "agent"],
      ["20261109-080000-faultforge-3", "ticket"],
    ]);
  });

  it("reports the audit before verify, and verify before the agent", () => {
    const both = [
      ...stuckRun.slice(0, -2),
      ev("audited", { problems: ["main of faultforge moved"] }),
      ev("verified", { problems: ["checks not green"] }),
      ev("finished", { label: "agent-needs-help", reason: "audit" }),
    ];
    const verifyOnly = [
      ...doneRun.slice(0, -2),
      ev("verified", { problems: ["x"] }),
      ev("finished", { label: "agent-needs-help", reason: "v" }),
    ];
    const s = runStats([
      { id: "a", events: both },
      { id: "b", events: verifyOnly },
    ]);
    expect(s.stops.map((x) => x.where)).toEqual(["audit", "verify"]);
  });

  it("counts a failed pre-flight and a run that ended on a runner error", () => {
    const s = runStats([
      { id: "a", events: [ev("picked"), ev("claimed"), ev("hooks-checked", { ok: false })] },
      { id: "b", events: [ev("picked"), ev("claimed"), ev("error", { message: "gh failed", afterLabel: null })] },
    ]);
    expect(s.preflightFailed).toBe(1);
    expect(s.stops.find((x) => x.id === "a")?.where).toBe("preflight");
    expect(s.stops.find((x) => x.id === "b")).toEqual({ id: "b", where: "error", reason: "gh failed" });
  });

  it("calls a run a runner error only for the error a failed tick logs, never for one the run went on after", () => {
    const failedTick = [
      ...stuckRun.slice(0, 4),
      ev("error", { message: "the tick threw", afterLabel: null }),
      ev("finished", { label: "agent-needs-help", reason: "the runner failed" }),
    ];
    const failedReport = [...stuckRun, ev("error", { message: "couldn't report on the ticket" })];
    const failedLookup = [
      ...stuckRun.slice(0, 3),
      ev("error", { message: "couldn't list open pull requests" }),
      ...stuckRun.slice(3),
    ];
    const s = runStats([
      { id: "a", events: failedTick },
      { id: "b", events: failedReport },
      { id: "c", events: failedLookup },
    ]);
    expect(s.stops.map((x) => [x.id, x.where])).toEqual([
      ["a", "error"],
      ["b", "agent"],
      ["c", "agent"],
    ]);
  });

  it("counts a weakened or unread check as a failed verify, and an allowed one as passed", () => {
    const withCheckFiles = (outcome: string) => [
      ...doneRun.slice(0, -1),
      ev("check-files", { outcome }),
      ev("finished", {
        label: outcome === "allowed" ? "agent-done" : "agent-needs-help",
        reason: outcome,
      }),
    ];
    const s = runStats([
      { id: "a", events: withCheckFiles("check-weakened") },
      { id: "b", events: withCheckFiles("unread") },
      { id: "c", events: withCheckFiles("allowed") },
    ]);
    expect(s.stops.map((x) => [x.id, x.where])).toEqual([
      ["a", "verify"],
      ["b", "verify"],
    ]);
    expect(s.verified).toBe(3);
    expect(s.verifyProblems).toBe(2);
    expect(s.verified - s.verifyProblems).toBe(s.done);
  });

  it("sends each run down one path only: an audit problem is never also counted as verified", () => {
    const auditThenCleanVerify = [
      ...doneRun.slice(0, -3),
      ev("audited", { problems: ["main of faultforge moved"] }),
      ev("verified", { problems: [] }),
      ev("finished", { label: "agent-needs-help", reason: "audit" }),
    ];
    const verifyProblem = [
      ...doneRun.slice(0, -2),
      ev("verified", { problems: ["checks not green"] }),
      ev("finished", { label: "agent-needs-help", reason: "verify" }),
    ];
    const s = runStats([
      { id: "a", events: auditThenCleanVerify },
      { id: "b", events: verifyProblem },
      { id: "c", events: doneRun },
    ]);
    expect(s.verified).toBe(2);
    expect(s.verifyProblems).toBe(1);
    expect(s.verified - s.verifyProblems).toBe(s.done);
    expect(s.stops.map((x) => x.where)).toEqual(["audit", "verify"]);
  });
});

describe("mermaid", () => {
  it("takes the round limit and the labels from the gate", () => {
    const s = runStats(runs);
    expect(mermaid(s, gate, [])).toContain("at most 3 review rounds");
    const changed = mermaid(s, { ...gate, maxRounds: 5, fix: ["action_required"] }, []);
    expect(changed).toContain("at most 5 review rounds");
    expect(changed).toContain("fix: action_required<br/>");
  });

  it("draws every required step, the planned ones dashed", () => {
    const chart = mermaid(runStats(runs), gate, ["npm run check", "npm run check (windows)"]);
    const line = (text: string) => chart.split("\n").find((l) => l.includes(text)) ?? "";
    expect(line("Codebase Wisdom")).toContain(":::planned");
    expect(line("Qodo local review of")).toContain(":::planned");
    expect(line("Review Resolver")).toContain(":::planned");
    expect(line("Review Resolver")).toContain("PLANNED: Review Resolver");
    expect(line("review of the head commit is complete")).not.toContain(":::planned");
    expect(line("ci:wait")).toContain("npm run check (windows)");
    expect(chart).toContain("round limit, budget or time");
    expect(chart).toContain("the owner checks the criteria and merges");
    expect(chart).toContain("Owner rewrites the ticket");
    expect(chart).toContain("classDef planned stroke-dasharray");
  });

  it("gives a failed pre-flight its own path to the owner", () => {
    const s = runStats([{ id: "a", events: [ev("picked"), ev("claimed"), ev("qodo-checked", { exitCode: 1 })] }]);
    expect(mermaid(s, gate, [])).toContain('P -- "failed: 1" --> H');
  });

  it("keeps quotes and pipes out of the labels", () => {
    const chart = mermaid(runStats(runs), { ...gate, fix: ['a"b|c'] }, []);
    expect(chart).toContain("a#quot;b#124;c");
  });
});

describe("diagramDoc", () => {
  it("lists each stop with its reason, pipes escaped", () => {
    const doc = diagramDoc(runStats(runs), config, []);
    expect(doc).toContain("1 of 3 runs ended as `agent-done`");
    expect(doc).toContain(
      "| `20261110-110000-faultforge-2` | agent's own loop | Three review rounds \\| one finding open |",
    );
    expect(doc).toContain("No run record was skipped.");
    expect(doc.split("\n").length).toBeLessThanOrEqual(150);
  });

  it("names the first and last run counted", () => {
    const doc = diagramDoc(runStats(runs), config, []);
    expect(doc).toContain("`20261109-080000-faultforge-3` to `20261110-110000-faultforge-2`");
  });

  it("stays within docs:check's 150 lines however many runs stopped", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `run-${String(i).padStart(3, "0")}`,
      events: notReadyRun,
    }));
    const doc = diagramDoc(runStats(many), config, []);
    expect(doc.split("\n").length).toBeLessThanOrEqual(150);
    expect(doc).toContain("| ticket:ready | 200 |");
    expect(doc).toContain("The latest 30 of 200 stopped runs");
    expect(doc).toContain("`run-199`");
  });
});

describe("readRuns", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads lab runs only, and skips a record it can't read without counting it", () => {
    dir = tempDir("ff-diagram-");
    writeFileSync(join(dir, "20261110-100000-faultforge-1.jsonl"), jsonl(doneRun));
    writeFileSync(join(dir, "20261110-100000-faultforge-1.agent.jsonl"), jsonl([ev("assistant")]));
    writeFileSync(join(dir, "20261110-110000-target-18.jsonl"), jsonl(doneRun));
    writeFileSync(join(dir, "20261110-120000-faultforge-9.jsonl"), '{"t":"x","event":"picked"}\nnot json\n');
    const { runs: read, skipped } = readRuns(dir);
    expect(read.map((r) => r.id)).toEqual(["20261110-100000-faultforge-1"]);
    expect(skipped).toEqual([
      { file: "20261110-120000-faultforge-9.jsonl", reason: expect.stringContaining("line 2") },
    ]);
    const doc = diagramDoc(runStats(read), config, skipped);
    expect(doc).toContain("Skipped, not readable: `20261110-120000-faultforge-9.jsonl`");
    expect(doc).toContain("from 1 lab run records");
  });

  it("skips a record with an event that has no valid time", () => {
    dir = tempDir("ff-diagram-time-");
    writeFileSync(join(dir, "20261110-100000-faultforge-1.jsonl"), jsonl([{ event: "finished", label: "agent-done" }]));
    const { runs: read, skipped } = readRuns(dir);
    expect(read).toEqual([]);
    expect(skipped[0]?.reason).toBe("event 1 has no event name or no valid time");
  });

  it("exits 2 when there are no run records", () => {
    dir = tempDir("ff-diagram-root-");
    mkdirSync(join(dir, "docs"));
    expect(main([], dir)).toBe(2);
  });
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// realDeps' wiring, on fakes: no real gh, git, npm or claude process runs in this file. Each module realDeps
// calls out to keeps its real exports except the ones that would reach the outside world.
vi.mock("./github.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github.ts")>()),
  gh: vi.fn(() => ""),
  ghAll: vi.fn(() => []),
  ghJson: vi.fn(),
  ghApiJson: vi.fn(),
}));
vi.mock("./factory-exec.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./factory-exec.ts")>()),
  git: vi.fn(() => ""),
  gitLong: vi.fn(() => ""),
  npm: vi.fn(() => ({ status: 0, output: "" })),
}));
vi.mock("./factory-agent.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./factory-agent.ts")>()),
  runAgent: vi.fn(),
}));
vi.mock("./factory-audit.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./factory-audit.ts")>()),
  auditRun: vi.fn(() => []),
}));
vi.mock("./factory-verify.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./factory-verify.ts")>()),
  verifyPrWith: vi.fn(() => ({ problems: [] })),
}));
vi.mock("./factory-evidence.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./factory-evidence.ts")>()),
  commitAndPublish: vi.fn(() => ({ pushed: true, blocked: [] })),
}));
vi.mock("./factory-hooks.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./factory-hooks.ts")>()),
  requireHooks: vi.fn(() => ({ problems: [], hooks: [] })),
}));
vi.mock("./guard-install.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./guard-install.ts")>()),
  unguardedCheckouts: vi.fn(() => ["faultforge-target: no guard hooks"]),
}));
vi.mock("./ticket-ready.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ticket-ready.ts")>()),
  checkTicket: vi.fn(() => ({ title: "t", problems: [] })),
}));

import { runAgent } from "./factory-agent.ts";
import { auditRun } from "./factory-audit.ts";
import type { FactoryConfig } from "./factory-config.ts";
import { realDeps } from "./factory-deps.ts";
import { commitAndPublish } from "./factory-evidence.ts";
import { git, gitLong, npm } from "./factory-exec.ts";
import { type Candidate, setupRefusal, type Workspace } from "./factory-tick.ts";
import { verifyPrWith } from "./factory-verify.ts";
import { ExternalCallError, gh, ghAll, ghJson } from "./github.ts";
import { unguardedCheckouts } from "./guard-install.ts";
import { ROOT as LAB_ROOT } from "./paths.ts";
import { checkTicket } from "./ticket-ready.ts";

const FACTORY: FactoryConfig = {
  evidence: "private/raw-artifacts",
  repos: {
    lab: {
      github: "owner/lab",
      path: ".",
      guard: "lab",
      check: "npm run check",
      tests: "\\.test\\.ts$",
      start: null,
      tickets: { sections: ["Result"], checklist: "Result" },
      board: true,
    },
    target: {
      github: "owner/target",
      path: "../target",
      guard: "reviewed",
      check: "npm run check",
      tests: "\\.test\\.ts$",
      start: null,
      tickets: { sections: ["What"], checklist: "What" },
      board: false,
    },
  },
};

const OPTIONS = { minutes: 120, budget: 25 };

describe("hooks-checked reaches the run's saved and published log (#126)", () => {
  const LAB = join(import.meta.dirname, "../../..");
  it("the real log writer appends the event, whole, to the run's .jsonl file", () => {
    const dir = mkdtempSync(join(tmpdir(), "runs-hooks-"));
    const before = process.env.FAULTFORGE_RUNS_DIR;
    process.env.FAULTFORGE_RUNS_DIR = dir;
    try {
      const event = { t: "2026-11-12T10:00:00.000Z", event: "hooks-checked", ok: true, slowestMs: 40, problems: [] };
      realDeps(FACTORY, OPTIONS).record("20261112-100000-lab-1", event);
      const lines = readFileSync(join(dir, "20261112-100000-lab-1.jsonl"), "utf8").trim().split("\n");
      expect(lines.map((l) => JSON.parse(l))).toEqual([event]);
    } finally {
      if (before === undefined) delete process.env.FAULTFORGE_RUNS_DIR;
      else process.env.FAULTFORGE_RUNS_DIR = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the workflow publishes every run log except the agent's transcript, so the event is public", () => {
    const workflow = readFileSync(join(LAB, ".github/workflows/factory.yml"), "utf8");
    // The workflow's own expression syntax, written as plain text on purpose.
    const runnerTemp = "$" + "{{ runner.temp }}";
    expect(workflow).toContain(`${runnerTemp}/faultforge-runs/*.jsonl`);
    expect(workflow).toContain(`!${runnerTemp}/faultforge-runs/*.agent.jsonl`);
  });

  it("docs/factory-trigger.md names the event where it describes the self-test", () => {
    const docs = readFileSync(join(LAB, "docs/factory-trigger.md"), "utf8");
    const selfTest = docs.indexOf("self-test");
    expect(selfTest).toBeGreaterThan(-1);
    expect(docs.slice(selfTest)).toContain("`hooks-checked`");
  });
});

describe("realDeps: each step reaches the right call, on fakes (#227)", () => {
  let runs: string;
  let before: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    runs = mkdtempSync(join(tmpdir(), "runs-deps-"));
    before = process.env.FAULTFORGE_RUNS_DIR;
    process.env.FAULTFORGE_RUNS_DIR = runs;
  });

  afterEach(() => {
    if (before === undefined) delete process.env.FAULTFORGE_RUNS_DIR;
    else process.env.FAULTFORGE_RUNS_DIR = before;
    rmSync(runs, { recursive: true, force: true });
  });

  const workspace = (root: string): Workspace => ({
    root,
    lab: join(root, "lab"),
    private: join(root, "lab", "private"),
    mainAtStart: {},
    fingerprints: {},
  });

  it("lists open issues with the label, leaving pull requests out", () => {
    vi.mocked(ghAll).mockReturnValueOnce([
      { number: 4, title: "An issue" },
      { number: 5, title: "A pull request", pull_request: {} },
    ]);
    expect(realDeps(FACTORY, OPTIONS).labelled("owner/target", "ready-for-agent")).toEqual([
      { number: 4, title: "An issue" },
    ]);
    expect(vi.mocked(ghAll).mock.calls[0]?.[0]).toBe(
      "repos/owner/target/issues?state=open&per_page=100&labels=ready-for-agent",
    );
  });

  it("reads a ticket's events, and asks ticket:ready about it", () => {
    realDeps(FACTORY, OPTIONS).events("owner/target", 18);
    expect(vi.mocked(ghAll).mock.calls[0]?.[0]).toBe("repos/owner/target/issues/18/events?per_page=100");
    realDeps(FACTORY, OPTIONS).ready("target", 18);
    expect(vi.mocked(checkTicket)).toHaveBeenCalledWith(FACTORY, "target", 18);
  });

  it("takes the ticket's snapshot from GitHub's GraphQL API", () => {
    const page = (field: string) => ({
      title: "Filter",
      body: "body",
      author: { login: "owner" },
      [field]: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    });
    vi.mocked(gh).mockImplementation((...args: string[]) => {
      const query = args.find((a) => a.startsWith("query=")) ?? "";
      const field = ["comments", "timelineItems", "userContentEdits"].find((f) => query.includes(`${f}(`)) ?? "";
      return JSON.stringify({ data: { repository: { issue: page(field) } } });
    });
    try {
      const snapshot = realDeps(FACTORY, OPTIONS).snapshot("owner/target", 18);
      expect(snapshot.text).toBe("# Filter\n\nbody");
      expect(snapshot.provenance.author).toBe("owner");
      expect(vi.mocked(gh).mock.calls).toHaveLength(3);
      for (const call of vi.mocked(gh).mock.calls) {
        expect(call.slice(0, 2)).toEqual(["api", "graphql"]);
        expect(call).toContain("owner=owner");
        expect(call).toContain("name=target");
        expect(call).toContain("number=18");
      }
    } finally {
      vi.mocked(gh).mockImplementation(() => "");
    }
  });

  it("writes the ticket text the agent reads into the run folder", () => {
    const root = join(runs, "run-1");
    mkdirSync(root, { recursive: true });
    const file = realDeps(FACTORY, OPTIONS).writeTicket(workspace(root), "# Filter");
    expect(file).toBe(join(root, "ticket.md"));
    expect(readFileSync(file, "utf8")).toBe("# Filter\n");
  });

  it("adds the new labels in one edit, then removes each old one on its own, ignoring a label already gone (AUD-M19)", () => {
    vi.mocked(gh)
      .mockImplementationOnce(() => "")
      .mockImplementationOnce(() => {
        throw new ExternalCallError("gh api", { stderr: "gh: Label does not exist (HTTP 404)\n" });
      });
    const problems = realDeps(FACTORY, OPTIONS).relabel(
      "owner/target",
      18,
      ["ready-for-agent", "agent-done"],
      ["agent-working"],
    );
    expect(problems).toEqual({ removeFailed: null, addFailed: null });
    expect(vi.mocked(gh).mock.calls).toEqual([
      ["issue", "edit", "18", "--repo", "owner/target", "--add-label", "agent-working"],
      ["api", "-X", "DELETE", "repos/owner/target/issues/18/labels/ready-for-agent"],
      ["api", "-X", "DELETE", "repos/owner/target/issues/18/labels/agent-done"],
    ]);
  });

  it("comments on the ticket with gh issue comment", () => {
    realDeps(FACTORY, OPTIONS).comment("owner/target", 18, "Picked up.");
    expect(vi.mocked(gh)).toHaveBeenCalledWith(
      "issue",
      "comment",
      "18",
      "--repo",
      "owner/target",
      "--body",
      "Picked up.",
    );
  });

  it("hands the agent launcher the run's options and runs folder", async () => {
    const ws = workspace(join(runs, "run-1"));
    const log = () => {};
    vi.mocked(runAgent).mockResolvedValueOnce({
      exitCode: 0,
      timedOut: false,
      resultText: null,
      subtype: "success",
      costUsd: 1,
      turns: 2,
    });
    const run = await realDeps(FACTORY, OPTIONS).runAgent(ws, "run-1", "target", 18, "/t.md", log);
    expect(run.exitCode).toBe(0);
    expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
      FACTORY,
      OPTIONS,
      runs,
      ws,
      "run-1",
      "target",
      18,
      "/t.md",
      log,
      expect.any(Function),
    );
  });

  it("verifies a pull request against the harness's own GitHub address, from the runs folder", () => {
    const ws = workspace(join(runs, "run-1"));
    realDeps(FACTORY, OPTIONS).verifyPr(ws, "target", 19);
    const call = vi.mocked(verifyPrWith).mock.calls[0];
    expect(call?.[0]).toEqual({ ghJson, git, npm: expect.any(Function) });
    expect(call?.slice(1, 3)).toEqual([FACTORY, runs]);
    expect(call?.[3]("owner/lab")).toBe("https://github.com/owner/lab.git");
    expect(call?.slice(4)).toEqual([ws, "target", 19]);
  });

  it("audits against the checkout's own private folder, in the run's mode", () => {
    const ws = workspace(join(runs, "run-1"));
    const ticket: Candidate = {
      repoKey: "target",
      github: "owner/target",
      number: 18,
      title: "Filter",
      labelledAt: "",
      labelledBy: "owner",
    };
    realDeps(FACTORY, OPTIONS, "ci").audit(ws, ticket, "a", "b");
    expect(vi.mocked(auditRun)).toHaveBeenCalledWith(FACTORY, join(LAB_ROOT, "private"), "ci", ws, ticket, "a", "b");
  });

  it("copies the run log and transcript into the workspace's private worktree, then publishes them", () => {
    const ws = workspace(join(runs, "run-1"));
    writeFileSync(join(runs, "run-1.jsonl"), "{}\n");
    writeFileSync(join(runs, "run-1.agent.jsonl"), "{}\n");
    mkdirSync(ws.private, { recursive: true });
    writeFileSync(join(ws.private, ".git"), "gitdir: elsewhere\n");
    const saved = realDeps(FACTORY, OPTIONS).saveEvidence("run-1", ws);
    const dir = join(ws.private, "raw-artifacts", "factory-runs");
    expect(existsSync(join(dir, "run-1.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "run-1.agent.jsonl"))).toBe(true);
    expect(vi.mocked(commitAndPublish)).toHaveBeenCalledWith(ws.private, "raw-artifacts", "run-1", git, gitLong);
    expect(saved).toEqual({ file: "private/raw-artifacts/factory-runs/run-1.jsonl", pushed: true, blocked: [] });
    // The workspace's own worktree is never torn down here: only a temporary one is.
    expect(vi.mocked(git)).not.toHaveBeenCalled();
  });

  it("never saves through a private worktree that is gone: git would find the harness instead (Qodo on PR 262)", () => {
    const ws = workspace(join(runs, "run-gone"));
    rmSync(ws.private, { recursive: true, force: true });
    expect(() => realDeps(FACTORY, OPTIONS).saveEvidence("run-gone", ws)).toThrow(/private worktree is gone/);
    expect(vi.mocked(commitAndPublish)).not.toHaveBeenCalled();
  });

  it("a local tick refuses to start beside a reviewed checkout without the git-level guard; CI installs it itself (#242)", () => {
    expect(realDeps(FACTORY, OPTIONS).unguarded?.()).toEqual(["faultforge-target: no guard hooks"]);
    expect(vi.mocked(unguardedCheckouts)).toHaveBeenCalledWith(FACTORY, LAB_ROOT);
    expect(setupRefusal(realDeps(FACTORY, OPTIONS))).toMatch(
      /^factory:tick refused: faultforge-target: no guard hooks. Run npm run guard:install first.$/,
    );
    vi.mocked(unguardedCheckouts).mockClear();
    expect(setupRefusal(realDeps(FACTORY, OPTIONS, "ci"))).toBeNull();
    expect(vi.mocked(unguardedCheckouts)).not.toHaveBeenCalled();
    expect(setupRefusal({ unguarded: () => [] })).toBeNull();
  });

  it("takes the lock in the runs folder when local, and never holds one in CI", () => {
    const first = realDeps(FACTORY, OPTIONS).lock();
    expect(first.acquired).toBe(true);
    expect(existsSync(join(runs, "factory.lock"))).toBe(true);
    expect(realDeps(FACTORY, OPTIONS).lock().acquired).toBe(false);
    expect(realDeps(FACTORY, OPTIONS, "ci").lock().acquired).toBe(true);
    first.release();
    expect(existsSync(join(runs, "factory.lock"))).toBe(false);
  });

  it("leaves CI's checkouts alone on cleanup: the VM is thrown away", () => {
    realDeps(FACTORY, OPTIONS, "ci").cleanup(workspace(join(runs, "run-1")));
    expect(vi.mocked(git)).not.toHaveBeenCalled();
    expect(vi.mocked(gitLong)).not.toHaveBeenCalled();
  });
});

describe("realDeps: the workspace installs each repo's packages, on fakes (Qodo on PR 240)", () => {
  let runs: string;
  let before: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    runs = mkdtempSync(join(tmpdir(), "runs-install-"));
    before = process.env.FAULTFORGE_RUNS_DIR;
    process.env.FAULTFORGE_RUNS_DIR = runs;
  });

  afterEach(() => {
    vi.mocked(npm).mockImplementation(() => ({ status: 0, output: "" }));
    if (before === undefined) delete process.env.FAULTFORGE_RUNS_DIR;
    else process.env.FAULTFORGE_RUNS_DIR = before;
    rmSync(runs, { recursive: true, force: true });
  });

  /** The folders the faked `git worktree add` would have made: the lab with its guardrails, and the target. */
  const layout = (runId: string, withTargetPackage: boolean) => {
    const root = join(runs, runId);
    const lab = join(root, basename(LAB_ROOT));
    const target = join(root, "target");
    mkdirSync(join(lab, ".claude"), { recursive: true });
    writeFileSync(join(lab, ".claude", "settings.json"), "{}");
    writeFileSync(join(lab, "package.json"), "{}");
    mkdirSync(target, { recursive: true });
    if (withTargetPackage) writeFileSync(join(target, "package.json"), "{}");
    return { root, lab, target };
  };

  it("runs npm ci in every worktree that has a package.json, and only there", () => {
    const { lab, target } = layout("run-1", true);
    const ws = realDeps(FACTORY, OPTIONS).workspace("run-1");
    expect(ws.lab).toBe(lab);
    expect(vi.mocked(npm).mock.calls).toEqual([
      [lab, ["ci", "--no-audit", "--no-fund"]],
      [target, ["ci", "--no-audit", "--no-fund"]],
    ]);
  });

  it("skips a worktree without a package.json", () => {
    const { lab } = layout("run-2", false);
    realDeps(FACTORY, OPTIONS).workspace("run-2");
    expect(vi.mocked(npm).mock.calls).toEqual([[lab, ["ci", "--no-audit", "--no-fund"]]]);
  });

  it("throws with the folder and the end of npm's output when an install fails, and removes the run folder", () => {
    const { root, lab } = layout("run-3", true);
    const output = `${"x".repeat(100)}${"y".repeat(400)}`;
    vi.mocked(npm).mockImplementation(() => ({ status: 1, output }));
    expect(() => realDeps(FACTORY, OPTIONS).workspace("run-3")).toThrow(
      new Error(`npm ci failed in ${lab}: ${"y".repeat(400)}`),
    );
    expect(vi.mocked(npm)).toHaveBeenCalledTimes(1);
    expect(existsSync(root)).toBe(false);
  });
});

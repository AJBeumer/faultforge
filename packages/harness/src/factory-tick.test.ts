import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "./factory-config.ts";
import {
  type AgentRun,
  agentStep,
  checkProblems,
  type IssueEvent,
  LABELS,
  lastLabelled,
  oldest,
  parseAgentResult,
  prNumber,
  runIdFor,
  safeText,
  settle,
  type TickDeps,
  tick,
  type Workspace,
} from "./factory-tick.ts";

const FACTORY: FactoryConfig = {
  evidence: "private/raw-artifacts",
  repos: {
    lab: {
      github: "owner/lab",
      path: ".",
      guard: "lab",
      check: "npm run check",
      start: null,
      tickets: { sections: ["Result"], checklist: "Result" },
      board: true,
    },
    target: {
      github: "owner/target",
      path: "../target",
      guard: "reviewed",
      check: "npm run check",
      start: null,
      tickets: { sections: ["What"], checklist: "What" },
      board: false,
    },
  },
};

const labelled = (by: string, at: string, name: string = LABELS.ready): IssueEvent => ({
  event: "labeled",
  created_at: at,
  actor: { login: by },
  label: { name },
});

const AGENT_OK: AgentRun = {
  exitCode: 0,
  timedOut: false,
  resultText:
    'All done.\nFACTORY_RESULT {"outcome":"ready","pr":"https://github.com/owner/target/pull/19","reason":"done"}',
  subtype: "success",
  costUsd: 3.2,
  turns: 80,
};

interface Fake {
  deps: TickDeps;
  calls: string[];
  comments: { github: string; number: number; body: string }[];
  events: Record<string, unknown>[];
  printed: string[];
  released: () => boolean;
}

/** A fake world: `issues` maps "github#n" to its title and events; everything else is overridable. */
function fake(
  issues: Record<string, { title: string; events: IssueEvent[] }>,
  overrides: Partial<TickDeps> = {},
  busy = false,
): Fake {
  const calls: string[] = [];
  const comments: Fake["comments"] = [];
  const events: Fake["events"] = [];
  const printed: string[] = [];
  let released = false;
  const ws: Workspace = {
    root: "/runs/r",
    lab: "/runs/r/lab",
    private: "/runs/r/lab/private",
    mainAtStart: { target: "aaa", lab: "bbb" },
  };
  let clock = Date.parse("2026-11-09T09:30:00Z");
  const deps: TickDeps = {
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
    print: (line) => printed.push(line),
    lock: () =>
      busy
        ? { acquired: false, release: () => {}, note: "pid 1" }
        : { acquired: true, release: () => (released = true) },
    labelled: (github) =>
      Object.entries(issues)
        .filter(([key]) => key.startsWith(`${github}#`))
        .map(([key, value]) => ({ number: Number(key.split("#")[1]), title: value.title })),
    events: (github, number) => issues[`${github}#${number}`]?.events ?? [],
    ready: () => ({ title: "t", problems: [] }),
    relabel: (github, number, remove, add) =>
      calls.push(`relabel ${github}#${number} -${remove.join(",")} +${add.join(",")}`),
    comment: (github, number, body) => comments.push({ github, number, body }),
    workspace: () => {
      calls.push("workspace");
      return ws;
    },
    runAgent: async () => {
      calls.push("agent");
      return AGENT_OK;
    },
    verifyPr: () => ({ problems: [] }),
    mainSha: () => "aaa",
    saveEvidence: (runId, w) => {
      calls.push(`save ${w ? "with" : "without"} workspace`);
      return `private/raw-artifacts/factory-runs/${runId}.jsonl`;
    },
    cleanup: () => calls.push("cleanup"),
    record: (_id, event) => events.push(event as Record<string, unknown>),
    ...overrides,
  };
  return { deps, calls, comments, events, printed, released: () => released };
}

const OPTIONS = { minutes: 120, budget: 25 };

describe("tick: stop paths", () => {
  it("is idle with no labelled ticket, and starts nothing", async () => {
    const f = fake({});
    expect(await tick(FACTORY, f.deps, OPTIONS)).toBe("idle");
    expect(f.calls).toEqual([]);
    expect(f.printed.join("\n")).toMatch(/idle/);
    expect(f.released()).toBe(true);
  });

  it("is busy when another run holds the lock, and reads nothing", async () => {
    let read = false;
    const f = fake(
      {},
      {
        labelled: () => {
          read = true;
          return [];
        },
      },
      true,
    );
    expect(await tick(FACTORY, f.deps, OPTIONS)).toBe("busy");
    expect(read).toBe(false);
    expect(f.printed.join("\n")).toMatch(/busy.*pid 1/);
  });

  it("refuses a ticket labelled by someone other than the owner, removes the label and starts nothing", async () => {
    const f = fake({
      "owner/target#18": {
        title: "Filter",
        events: [labelled("owner", "2026-11-09T08:00:00Z"), labelled("stranger", "2026-11-09T09:00:00Z")],
      },
    });
    expect(await tick(FACTORY, f.deps, OPTIONS)).toBe("refused");
    expect(f.calls).toEqual(["relabel owner/target#18 -ready-for-agent +", "save without workspace"]);
    expect(f.comments[0]?.body).toMatch(/added by stranger, and only the repository owner/);
    expect(f.comments[0]?.body).not.toMatch(/@stranger/);
    expect(f.events.map((e) => e.event)).toEqual(["picked", "refused"]);
  });

  it("matches the owner's login case-insensitively", async () => {
    const f = fake({ "owner/target#18": { title: "Filter", events: [labelled("Owner", "2026-11-09T08:00:00Z")] } });
    expect(await tick(FACTORY, f.deps, OPTIONS)).toBe("done");
  });

  it("refuses a ticket that isn't ready, with the reasons, and starts nothing", async () => {
    const f = fake(
      { "owner/target#18": { title: "Filter", events: [labelled("owner", "2026-11-09T08:00:00Z")] } },
      { ready: () => ({ title: "Filter", problems: ['missing section "What"'] }) },
    );
    expect(await tick(FACTORY, f.deps, OPTIONS)).toBe("not-ready");
    expect(f.calls).toEqual([`relabel owner/target#18 -ready-for-agent +${LABELS.help}`, "save without workspace"]);
    expect(f.comments[0]?.body).toMatch(/missing section "What"/);
  });

  it("claims before the agent starts, then finishes done and cleans up", async () => {
    const f = fake({ "owner/target#18": { title: "Filter", events: [labelled("owner", "2026-11-09T08:00:00Z")] } });
    expect(await tick(FACTORY, f.deps, OPTIONS)).toBe("done");
    expect(f.calls).toEqual([
      `relabel owner/target#18 -ready-for-agent +${LABELS.working}`,
      "workspace",
      "agent",
      `relabel owner/target#18 -${LABELS.working} +${LABELS.done}`,
      "save with workspace",
      "cleanup",
    ]);
    expect(f.comments[0]?.body).toMatch(/Picked up by scheduled agent run `20261109-093001-target-18`/);
    expect(f.comments[1]?.body).toMatch(/ready for the owner to merge[\s\S]*pull\/19/);
    expect(f.events.map((e) => e.event)).toEqual([
      "picked",
      "claimed",
      "workspace",
      "agent-started",
      "agent-finished",
      "verified",
      "finished",
      "saved",
    ]);
  });

  it("takes the ticket labelled longest ago, across repos, one per tick", async () => {
    const f = fake({
      "owner/target#18": { title: "Later", events: [labelled("owner", "2026-11-09T09:00:00Z")] },
      "owner/lab#63": { title: "Earlier", events: [labelled("owner", "2026-11-09T08:00:00Z")] },
    });
    await tick(FACTORY, f.deps, OPTIONS);
    expect(f.events[0]).toMatchObject({ event: "picked", repo: "lab", ticket: 63, waiting: 1 });
    expect(f.calls.filter((c) => c === "agent")).toHaveLength(1);
  });

  it("needs help when the agent hits the time limit, and keeps the worktrees", async () => {
    const f = fake(
      { "owner/target#18": { title: "Filter", events: [labelled("owner", "2026-11-09T08:00:00Z")] } },
      { runAgent: async () => ({ ...AGENT_OK, timedOut: true, resultText: null }) },
    );
    expect(await tick(FACTORY, f.deps, OPTIONS)).toBe("needs-help");
    expect(f.calls).toContain(`relabel owner/target#18 -${LABELS.working} +${LABELS.help}`);
    expect(f.calls).not.toContain("cleanup");
    expect(f.comments[1]?.body).toMatch(/time limit of 120 minutes/);
  });

  it("needs help when the agent says ready but the runner finds main moved", async () => {
    const f = fake(
      { "owner/target#18": { title: "Filter", events: [labelled("owner", "2026-11-09T08:00:00Z")] } },
      { mainSha: () => "ccc" },
    );
    expect(await tick(FACTORY, f.deps, OPTIONS)).toBe("needs-help");
    expect(f.comments[1]?.body).toMatch(/main moved during the run/);
  });

  it("needs help, and reports it on the ticket, when the runner itself fails after the claim", async () => {
    const f = fake(
      { "owner/target#18": { title: "Filter", events: [labelled("owner", "2026-11-09T08:00:00Z")] } },
      {
        workspace: () => {
          throw new Error("npm ci failed");
        },
      },
    );
    expect(await tick(FACTORY, f.deps, OPTIONS)).toBe("needs-help");
    expect(f.calls).toContain(`relabel owner/target#18 -${LABELS.working} +${LABELS.help}`);
    expect(f.comments[1]?.body).toMatch(/runner failed \(npm ci failed\)/);
    expect(f.released()).toBe(true);
  });

  it("never posts lab words on a reviewed repo's ticket", async () => {
    const f = fake(
      { "owner/target#18": { title: "Filter", events: [labelled("owner", "2026-11-09T08:00:00Z")] } },
      {
        runAgent: async () => ({
          ...AGENT_OK,
          resultText: 'FACTORY_RESULT {"outcome":"stuck","pr":null,"reason":"the FaultForge ledger is locked"}',
        }),
      },
    );
    expect(await tick(FACTORY, f.deps, OPTIONS)).toBe("needs-help");
    expect(f.comments.map((c) => c.body).join("\n")).not.toMatch(/faultforge|ledger/i);
    expect(f.comments[1]?.body).toBe("The details are in the run log.");
  });
});

describe("settle", () => {
  const verified = () => ({ problems: [] });
  const result = parseAgentResult(AGENT_OK.resultText);

  it("is done only when the agent reports ready and the runner confirms it", () => {
    expect(settle(AGENT_OK, result, verified, "owner/target", 120).label).toBe(LABELS.done);
    expect(settle(AGENT_OK, result, () => ({ problems: ["checks not green"] }), "owner/target", 120)).toMatchObject({
      label: LABELS.help,
      reason: expect.stringMatching(/checks not green/),
    });
  });

  it("needs help when the PR is in another repo, or missing", () => {
    expect(settle(AGENT_OK, result, verified, "owner/lab", 120).reason).toMatch(/without a pull request in owner\/lab/);
    expect(settle(AGENT_OK, { outcome: "ready", pr: null, reason: "x" }, verified, "owner/target", 120).label).toBe(
      LABELS.help,
    );
  });

  it("needs help without a result line, naming the agent's own stop reason", () => {
    expect(
      settle(
        { ...AGENT_OK, resultText: "I ran out", subtype: "error_max_budget_usd", exitCode: 1 },
        null,
        verified,
        "owner/target",
        120,
      ).reason,
    ).toMatch(/without a result, exit code 1 \(error_max_budget_usd\)/);
  });

  it("passes an owner gate through as done, with its reason", () => {
    const gate = {
      outcome: "owner-gate" as const,
      pr: "https://github.com/owner/target/pull/19",
      reason: "it changes AGENTS.md",
    };
    expect(settle(AGENT_OK, gate, verified, "owner/target", 120)).toMatchObject({
      label: LABELS.done,
      reason: "waiting for the owner: it changes AGENTS.md",
    });
  });
});

describe("helpers", () => {
  it("reads who added the label last", () => {
    expect(
      lastLabelled(
        [
          labelled("a", "2026-11-09T08:00:00Z"),
          labelled("b", "2026-11-09T07:00:00Z"),
          labelled("c", "2026-11-09T09:00:00Z", "bug"),
        ],
        LABELS.ready,
      ),
    ).toEqual({
      by: "a",
      at: "2026-11-09T08:00:00Z",
    });
    expect(lastLabelled([], LABELS.ready)).toBeNull();
  });

  it("breaks ties by repo key, then number", () => {
    const at = "2026-11-09T08:00:00Z";
    const c = (repoKey: string, number: number) => ({
      repoKey,
      number,
      github: "",
      title: "",
      labelledAt: at,
      labelledBy: "",
    });
    expect(oldest([c("target", 2), c("lab", 9), c("lab", 3)])).toMatchObject({ repoKey: "lab", number: 3 });
  });

  it("parses only a well-formed last result line", () => {
    expect(
      parseAgentResult(
        'FACTORY_RESULT {"outcome":"stuck","pr":null,"reason":"x"}\nFACTORY_RESULT {"outcome":"ready","pr":"u","reason":"y"}',
      )?.outcome,
    ).toBe("ready");
    expect(parseAgentResult('FACTORY_RESULT {"outcome":"merged"}')).toBeNull();
    expect(parseAgentResult("FACTORY_RESULT {not json}")).toBeNull();
    expect(parseAgentResult(null)).toBeNull();
  });

  it("accepts a PR URL only for the exact repo", () => {
    expect(prNumber("https://github.com/owner/target/pull/19", "owner/target")).toBe(19);
    expect(prNumber("https://github.com/owner/target-fork/pull/19", "owner/target")).toBeNull();
    expect(prNumber("https://github.com/owner/target/issues/19", "owner/target")).toBeNull();
  });

  it("treats pending, failed and absent checks as not green", () => {
    expect(checkProblems([{ name: "check", conclusion: "SUCCESS" }])).toEqual([]);
    expect(checkProblems([{ name: "check", status: "IN_PROGRESS", conclusion: "" }])[0]).toMatch(/check IN_PROGRESS/);
    expect(checkProblems([{ name: "check", conclusion: "FAILURE" }])[0]).toMatch(/FAILURE/);
    expect(checkProblems([])[0]).toMatch(/no checks ran/);
  });

  it("replaces lab words only in reviewed repos", () => {
    expect(safeText("FaultForge says hi", false)).toBe("FaultForge says hi");
    expect(safeText("FaultForge says hi", true)).toBe("The details are in the run log.");
    expect(safeText("Filter added", true)).toBe("Filter added");
  });

  it("makes sortable run ids and names timeline steps", () => {
    expect(runIdFor(new Date("2026-11-09T09:30:12.345Z"), "target", 18)).toBe("20261109-093012-target-18");
    expect(agentStep("cd x && gh pr create --title t")).toBe("pr-opened");
    expect(agentStep("npm run review:wait -- target 19")).toBe("review-wait");
    expect(agentStep("ls")).toBeNull();
  });
});

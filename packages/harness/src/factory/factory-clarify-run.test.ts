import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { ANSWER_MARKER } from "./factory-clarify.ts";
import {
  type AgentProcess,
  CLARIFY_BUDGET_USD,
  CLARIFY_DENIED_TOOLS,
  CLARIFY_TOOLS,
  clarifyArgs,
  clarifyDeny,
  clarifyEnv,
  clarifyFromEnd,
  clarifyResult,
  waitForAgent,
} from "./factory-clarify-run.ts";

describe("the clarify agent's confinement", () => {
  it("may read and nothing else", () => {
    expect(CLARIFY_TOOLS).toEqual(["Read", "Glob", "Grep"]);
  });

  it("denies every other tool by name, since the workspace's own settings allow some shell commands", () => {
    for (const tool of ["Bash", "PowerShell", "Edit", "Write", "WebFetch", "WebSearch", "Task", "Skill"]) {
      expect(CLARIFY_DENIED_TOOLS).toContain(tool);
      // In the settings file too: a deny rule there wins over an allow rule of the project's settings.
      expect(clarifyDeny([])).toContain(tool);
    }
    expect(CLARIFY_DENIED_TOOLS.filter((tool) => CLARIFY_TOOLS.includes(tool))).toEqual([]);
  });

  it("starts headless, never asks, names the denied tools, loads no MCP server and caps the cost", () => {
    const args = clarifyArgs("the prompt", "/r/settings.json", "/r/mcp.json");
    expect(args.slice(0, 2)).toEqual(["-p", "the prompt"]);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read Glob Grep");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe(CLARIFY_DENIED_TOOLS.join(" "));
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe(String(CLARIFY_BUDGET_USD));
    expect(args[args.indexOf("--settings") + 1]).toBe("/r/settings.json");
    expect(args).toContain("--strict-mcp-config");
  });

  it("gets the run's allow-listed environment without any GitHub token", () => {
    const env = clarifyEnv(
      {
        PATH: "/bin",
        GH_TOKEN: "runner-token",
        FAULTFORGE_AGENT_TOKEN: "agent-token",
        QODO_KEY_FILE: "/k",
        ANTHROPIC_API_KEY: "key",
        FAULTFORGE_PRIVATE_DIR: "/p",
      },
      "run-1",
      "/runs/run-1",
    );
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.QODO_KEY_FILE).toBeUndefined();
    expect(env.FAULTFORGE_PRIVATE_DIR).toBeUndefined();
    expect(Object.values(env)).not.toContain("agent-token");
    expect(env.ANTHROPIC_API_KEY).toBe("key");
    expect(env.FAULTFORGE_FACTORY_RUN).toBe("run-1");
    expect(env.FAULTFORGE_RUN_ROOT).toBe("/runs/run-1");
    expect(env.CLAUDE_CODE_GLOB_NO_IGNORE).toBe("false");
    expect(env.FAULTFORGE_PRIVATE_CHECKOUTS).toBeUndefined();
  });

  it("is told the private checkouts its policy hook keeps it out of, as the builder is", () => {
    const env = clarifyEnv({ PATH: "/bin" }, "run-1", "/runs/run-1", ["/lab/private", "/runs"]);
    expect(env.FAULTFORGE_PRIVATE_CHECKOUTS).toBe(["/lab/private", "/runs"].join(delimiter));
  });

  it("denies its three tools on every private folder it is given, in both spellings of a drive", () => {
    const deny = clarifyDeny(["D:\\runs\\r\\lab\\private", "", "/lab/private", "/lab/private"]);
    expect(deny).toContain("Read(//d/runs/r/lab/private/**)");
    expect(deny).toContain("Grep(//D/runs/r/lab/private/**)");
    expect(deny).toContain("Glob(//lab/private/**)");
    // Two spellings of one folder and one of the other, three tools each, and nothing for the empty name.
    expect(deny.filter((rule) => rule.includes("("))).toHaveLength(9);
  });
});

describe("clarifyResult", () => {
  const envelope = (result: string, extra: object = {}) =>
    JSON.stringify({ result, total_cost_usd: 0.4, num_turns: 6, is_error: false, ...extra });

  it("reads the agent's answer, its cost and its turns", () => {
    const run = clarifyResult(envelope(`Read the code.\n${ANSWER_MARKER}{"questions":[]}`), 0, false);
    expect(run).toEqual({ outcome: { kind: "none" }, costUsd: 0.4, turns: 6 });
  });

  it("is a failure when the agent ran out of time, whatever it printed", () => {
    const run = clarifyResult(envelope(`${ANSWER_MARKER}{"questions":[]}`), 0, true);
    expect(run.outcome).toMatchObject({ kind: "failed", reason: /longer than/ });
  });

  it("is a failure, never 'no questions', for a non-zero exit, an error result or unreadable output", () => {
    const fine = `${ANSWER_MARKER}{"questions":[]}`;
    expect(clarifyResult(envelope(fine), 1, false).outcome.kind).toBe("failed");
    expect(clarifyResult(envelope(fine, { is_error: true }), 0, false).outcome.kind).toBe("failed");
    expect(clarifyResult(JSON.stringify({ total_cost_usd: 0.1 }), 0, false).outcome.kind).toBe("failed");
    expect(clarifyResult("", null, false).outcome.kind).toBe("failed");
    expect(clarifyResult("not json", 0, false).outcome.kind).toBe("failed");
  });

  it("is a failure, not a crash, for output that is JSON but no object", () => {
    for (const out of ["null", "7", '"text"', "[]", "true"]) {
      expect(clarifyResult(out, 0, false).outcome).toMatchObject({ kind: "failed", reason: /no readable result/ });
    }
  });

  it("is a failure when the agent's reply has no answer line", () => {
    expect(clarifyResult(envelope("Looks fine."), 0, false).outcome).toMatchObject({ kind: "failed" });
  });
});

describe("waitForAgent", () => {
  /** A process a test drives by hand: it closes, errors or prints only when told to. */
  function process_() {
    const listeners: Record<string, ((value: never) => void)[]> = {};
    const on = (event: string, listener: (value: never) => void) => {
      listeners[event] = [...(listeners[event] ?? []), listener];
    };
    const child: AgentProcess = {
      pid: 4242,
      stdout: { on: (event, listener) => on(`out:${event}`, listener as never) },
      stderr: { on: (event, listener) => on(`err:${event}`, listener as never) },
      on: ((event: string, listener: (value: never) => void) => on(event, listener)) as AgentProcess["on"],
    };
    const emit = (event: string, value?: unknown) => {
      for (const listener of listeners[event] ?? []) listener(value as never);
    };
    return { child, emit };
  }
  const nothing = () => {};
  const tick = () => new Promise((done) => setImmediate(done));

  it("answers with the output, the error output and the exit code when the agent closes", async () => {
    const { child, emit } = process_();
    const waiting = waitForAgent(child, 60_000, nothing, nothing);
    emit("out:data", Buffer.from("half "));
    emit("err:data", Buffer.from("a warning"));
    emit("out:data", Buffer.from("answer"));
    emit("close", 0);
    expect(await waiting).toEqual({
      stdout: "half answer",
      stderr: "a warning",
      exitCode: 0,
      timedOut: false,
      overflowed: false,
    });
  });

  it("answers at its time limit even when the agent never closes and the kill throws", async () => {
    const { child } = process_();
    const errors: string[] = [];
    const killed: number[] = [];
    const result = await waitForAgent(
      child,
      20,
      (pid) => {
        killed.push(pid);
        throw new Error("no such process");
      },
      (message) => errors.push(message),
    );
    expect(result).toMatchObject({ stdout: "", exitCode: null, timedOut: true });
    // The kill is asked for after the answer, so it can't hold the answer back.
    await tick();
    expect(killed).toEqual([4242]);
    expect(errors.join(" ")).toMatch(/couldn't end the clarify agent at its time limit/);
  });

  it("answers once, and keeps nothing that arrives after the answer", async () => {
    const { child, emit } = process_();
    const result = await waitForAgent(child, 10, nothing, nothing);
    emit("out:data", Buffer.from("late output from a process that outlived its kill"));
    emit("close", 0);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("");
  });

  it("ends an agent that prints more than it keeps, and answers as overflowed", async () => {
    const { child, emit } = process_();
    const killed: number[] = [];
    const waiting = waitForAgent(child, 60_000, (pid) => killed.push(pid), nothing, 10);
    emit("out:data", Buffer.from("12345"));
    emit("out:data", Buffer.from("6789012345"));
    emit("out:data", Buffer.from("more"));
    const result = await waiting;
    expect(result).toMatchObject({ stdout: "12345", overflowed: true, timedOut: false, exitCode: null });
    await tick();
    expect(killed).toEqual([4242]);
  });

  it("says why the agent couldn't be started, and answers as not run", async () => {
    const { child, emit } = process_();
    const errors: string[] = [];
    const waiting = waitForAgent(child, 60_000, nothing, (message) => errors.push(message));
    emit("error", new Error("spawn claude ENOENT"));
    expect(await waiting).toMatchObject({ stdout: "", exitCode: null, timedOut: false });
    expect(errors).toEqual(["the clarify agent could not be started: spawn claude ENOENT"]);
  });
});

describe("clarifyFromEnd", () => {
  const fine = JSON.stringify({ result: `${ANSWER_MARKER}{"questions":[]}`, total_cost_usd: 0.4, num_turns: 6 });
  const ended = (extra: object = {}) => ({
    stdout: fine,
    stderr: "a warning",
    exitCode: 0,
    timedOut: false,
    overflowed: false,
    ...extra,
  });

  it("saves the agent's output and its error output before it reads the answer", () => {
    const saved: Record<string, string> = {};
    const run = clarifyFromEnd(
      ended(),
      (name, text) => {
        saved[name] = text;
      },
      () => {},
    );
    expect(run.outcome).toEqual({ kind: "none" });
    expect(saved).toEqual({ "clarify.json": fine, "clarify.stderr.txt": "a warning" });
  });

  it("doesn't act on an answer it couldn't save: the check failed, whatever the agent said", () => {
    const errors: string[] = [];
    const run = clarifyFromEnd(
      ended(),
      () => {
        throw new Error("disk full");
      },
      (message) => errors.push(message),
    );
    expect(run.outcome).toMatchObject({ kind: "failed", reason: /couldn't be saved/ });
    expect(errors.join(" ")).toMatch(/disk full/);
  });

  it("is a failed check when the output was cut, even if what is left reads as an answer", () => {
    expect(
      clarifyFromEnd(
        ended({ overflowed: true }),
        () => {},
        () => {},
      ).outcome,
    ).toMatchObject({
      kind: "failed",
      reason: /was cut/,
    });
  });
});

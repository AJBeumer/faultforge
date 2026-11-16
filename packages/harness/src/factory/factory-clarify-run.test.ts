import { describe, expect, it } from "vitest";
import { ANSWER_MARKER } from "./factory-clarify.ts";
import {
  CLARIFY_BUDGET_USD,
  CLARIFY_TOOLS,
  clarifyArgs,
  clarifyDeny,
  clarifyEnv,
  clarifyResult,
} from "./factory-clarify-run.ts";

describe("the clarify agent's confinement", () => {
  it("may read and nothing else: no shell, no edit, no network tool", () => {
    expect(CLARIFY_TOOLS).toEqual(["Read", "Glob", "Grep"]);
  });

  it("starts headless, never asks, loads no MCP server and caps the cost", () => {
    const args = clarifyArgs("the prompt", "/r/settings.json", "/r/mcp.json");
    expect(args.slice(0, 2)).toEqual(["-p", "the prompt"]);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read Glob Grep");
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
  });

  it("denies the run's private worktree to every tool it has, in both spellings of the drive", () => {
    const deny = clarifyDeny({ private: "D:\\runs\\r\\lab\\private" });
    expect(deny).toContain("Read(//d/runs/r/lab/private/**)");
    expect(deny).toContain("Grep(//D/runs/r/lab/private/**)");
    expect(deny).toHaveLength(6);
    expect(clarifyDeny({ private: "/runs/r/lab/private" })).toContain("Glob(//runs/r/lab/private/**)");
    expect(clarifyDeny({ private: "" })).toEqual([]);
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

  it("is a failure when the agent's reply has no answer line", () => {
    expect(clarifyResult(envelope("Looks fine."), 0, false).outcome).toMatchObject({ kind: "failed" });
  });
});

/**
 * Starts the clarify step's agent (`TickDeps.clarify`): a headless agent in the run's workspace that may only
 * read. Its words and the check of its answer are in `factory-clarify.ts`.
 *
 * It gets three tools, Read, Glob and Grep, and no other: no shell, no edit, no network tool, no MCP server.
 * Its environment is the builder's allow-list without a GitHub token, since it has nothing to post or push.
 * It is started through the same sandbox as the builder, so in a CI run it too runs as the sandbox user
 * behind the network allow-list. It has its own small budget and time limit.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeBinary } from "./factory-agent.ts";
import { agentEnv } from "./factory-agent-env.ts";
import { type ClarifyRun, clarifyPrompt, parseClarifyAnswer } from "./factory-clarify.ts";
import { killTree } from "./factory-kill.ts";
import { type AgentSandbox, type Launch, localSandbox } from "./factory-sandbox.ts";
import type { Logger, Workspace } from "./factory-tick-deps.ts";

/** The clarify agent's tools: it reads, and does nothing else. */
export const CLARIFY_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];

/** The most the clarify step may cost, in dollars, and take, in minutes. */
export const CLARIFY_BUDGET_USD = 2;
export const CLARIFY_MINUTES = 10;

/** The clarify agent's command line: its prompt, only `CLARIFY_TOOLS`, no MCP server, a capped budget. */
export function clarifyArgs(prompt: string, settingsFile: string, mcpConfigFile: string): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    CLARIFY_TOOLS.join(" "),
    "--max-budget-usd",
    String(CLARIFY_BUDGET_USD),
    "--settings",
    settingsFile,
    "--mcp-config",
    mcpConfigFile,
    "--strict-mcp-config",
  ];
}

/**
 * The clarify agent's environment: the builder's allow-list for this run, without the GitHub token. Pure.
 */
export function clarifyEnv(
  from: Record<string, string | undefined>,
  runId: string,
  runRoot: string,
): Record<string, string> {
  const { env } = agentEnv(from, { FAULTFORGE_FACTORY_RUN: runId, FAULTFORGE_RUN_ROOT: runRoot });
  delete env.GH_TOKEN;
  return env;
}

/** Deny rules for the clarify agent's file tools: the run's private worktree, when the run has one. */
export function clarifyDeny(ws: Pick<Workspace, "private">): string[] {
  if (!ws.private) return [];
  const path = ws.private.replace(/\\/g, "/").replace(/\/+$/, "");
  const drive = /^([a-zA-Z]):\/(.*)$/.exec(path);
  const spellings = drive
    ? [`//${(drive[1] as string).toLowerCase()}/${drive[2]}`, `//${(drive[1] as string).toUpperCase()}/${drive[2]}`]
    : [`/${path}`];
  return spellings.flatMap((p) => CLARIFY_TOOLS.map((tool) => `${tool}(${p}/**)`));
}

/** Pure: the run's result from the agent's output in `--output-format json`, or a failure that says why. */
export function clarifyResult(stdout: string, exitCode: number | null, timedOut: boolean): ClarifyRun {
  if (timedOut) {
    return {
      outcome: { kind: "failed", reason: `the check took longer than ${CLARIFY_MINUTES} minutes` },
      costUsd: null,
      turns: null,
    };
  }
  let envelope: { result?: unknown; total_cost_usd?: unknown; num_turns?: unknown; is_error?: unknown };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return {
      outcome: { kind: "failed", reason: `the agent gave no readable result (exit ${exitCode})` },
      costUsd: null,
      turns: null,
    };
  }
  const costUsd = typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null;
  const turns = typeof envelope.num_turns === "number" ? envelope.num_turns : null;
  if (exitCode !== 0 || envelope.is_error === true || typeof envelope.result !== "string") {
    return { outcome: { kind: "failed", reason: `the agent ended with an error (exit ${exitCode})` }, costUsd, turns };
  }
  return { outcome: parseClarifyAnswer(envelope.result), costUsd, turns };
}

/**
 * Runs the clarify agent on the ticket's text in `ws`, and returns what it found. Its output is saved to
 * `<runs>/<run id>.clarify.json`. Never throws for a failed or slow agent: that is a "failed" outcome.
 */
export async function runClarify(
  runs: string,
  ws: Workspace,
  runId: string,
  ticketText: string,
  log: Logger,
  sandbox: AgentSandbox = localSandbox,
): Promise<ClarifyRun> {
  const settingsFile = join(ws.root, "clarify-settings.json");
  writeFileSync(settingsFile, JSON.stringify({ permissions: { deny: clarifyDeny(ws) } }, null, 2));
  const mcpConfigFile = join(ws.root, "clarify-mcp.json");
  writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: {} }, null, 2));
  const args = clarifyArgs(clarifyPrompt(ticketText), settingsFile, mcpConfigFile);
  const env = clarifyEnv(process.env, runId, ws.root);
  log("clarify-started", { tools: CLARIFY_TOOLS, budgetUsd: CLARIFY_BUDGET_USD, minutes: CLARIFY_MINUTES });
  let launch: Launch;
  try {
    launch = await sandbox.open(claudeBinary(), args, env, log, () => {});
  } catch (error) {
    log("error", { message: (error as Error).message });
    return {
      outcome: { kind: "failed", reason: "the agent that checks a ticket could not be started" },
      costUsd: null,
      turns: null,
    };
  }
  const kill = launch.kill ?? ((pid: number) => killTree(pid));
  try {
    return await new Promise<ClarifyRun>((done) => {
      const child = spawn(launch.command, launch.args, {
        cwd: ws.lab,
        env: launch.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) kill(child.pid);
        } catch (error) {
          log("error", { message: `couldn't end the clarify agent at its time limit: ${(error as Error).message}` });
        }
      }, CLARIFY_MINUTES * 60_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      // Drained and dropped: it can hold anything the agent printed, and the answer is on stdout.
      child.stderr?.on("data", () => {});
      const end = (exitCode: number | null) => {
        clearTimeout(timer);
        try {
          writeFileSync(join(runs, `${runId}.clarify.json`), stdout);
        } catch (error) {
          log("error", { message: `couldn't save the clarify agent's output: ${(error as Error).message}` });
        }
        done(clarifyResult(stdout, exitCode, timedOut));
      };
      child.on("error", () => end(null));
      child.on("close", (code) => end(code));
    });
  } finally {
    await launch.close();
  }
}

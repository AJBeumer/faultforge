/**
 * Starts the clarify step's agent (`TickDeps.clarify`): a headless agent in the run's workspace that may only
 * read. Its words and the check of its answer are in `factory-clarify.ts`.
 *
 * It may use three tools, Read, Glob and Grep. Every other tool is denied by name, in its settings and on its
 * command line: the workspace's own settings allow some shell commands, and an allow-list alone would add
 * to those, not replace them. Its environment is the builder's allow-list without a GitHub token, since it
 * has nothing to post or push. It is told the same private checkouts as the builder, so the policy hook keeps
 * its reads out of them, and the ones that can be named as a folder are denied in its settings too. It is
 * started through the same sandbox as the builder, so in a CI run it too runs as the sandbox user behind the
 * network allow-list. It has its own small budget and a time limit the runner holds it to.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ROOT } from "../shared/paths.ts";
import { claudeBinary } from "./factory-agent.ts";
import { agentEnv } from "./factory-agent-env.ts";
import { type ClarifyRun, clarifyPrompt, parseClarifyAnswer } from "./factory-clarify.ts";
import { killTree } from "./factory-kill.ts";
import { privateCheckoutsFor } from "./factory-private.ts";
import { type AgentSandbox, type Launch, localSandbox } from "./factory-sandbox.ts";
import type { Logger, Workspace } from "./factory-tick-deps.ts";

/** The clarify agent's tools: it reads, and does nothing else. */
export const CLARIFY_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];

/** Every other tool, denied by name: a shell, an edit, the network, another agent, a skill, a notebook. */
export const CLARIFY_DENIED_TOOLS: readonly string[] = [
  "Bash",
  "PowerShell",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Skill",
  "ScheduleWakeup",
];

/** The most the clarify step may cost, in dollars, and take, in minutes. */
export const CLARIFY_BUDGET_USD = 2;
export const CLARIFY_MINUTES = 10;

/** The clarify agent's command line: its prompt, `CLARIFY_TOOLS` and no other tool, no MCP server, a capped budget. */
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
    "--disallowedTools",
    CLARIFY_DENIED_TOOLS.join(" "),
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
 * The clarify agent's environment: the builder's allow-list for this run, with the private checkouts its
 * policy hook keeps it out of, and without the GitHub token. Pure.
 */
export function clarifyEnv(
  from: Record<string, string | undefined>,
  runId: string,
  runRoot: string,
  privateCheckouts: string[] = [],
): Record<string, string> {
  const { env } = agentEnv(from, {
    FAULTFORGE_FACTORY_RUN: runId,
    FAULTFORGE_RUN_ROOT: runRoot,
    ...(privateCheckouts.length ? { FAULTFORGE_PRIVATE_CHECKOUTS: privateCheckouts.join(delimiter) } : {}),
  });
  delete env.GH_TOKEN;
  return env;
}

/** A folder as a deny rule spells it: forward slashes, and both cases of a drive letter. */
function spellings(folder: string): string[] {
  const path = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  const drive = /^([a-zA-Z]):\/(.*)$/.exec(path);
  return drive
    ? [`//${(drive[1] as string).toLowerCase()}/${drive[2]}`, `//${(drive[1] as string).toUpperCase()}/${drive[2]}`]
    : [`/${path}`];
}

/**
 * The clarify agent's deny rules: every tool but its three, by name, and its three on each private folder in
 * `privateFolders` (the run's own private worktree, the owner's private checkout, a configured one). Pure.
 */
export function clarifyDeny(privateFolders: string[]): string[] {
  const folders = [...new Set(privateFolders.filter(Boolean).flatMap(spellings))];
  return [...CLARIFY_DENIED_TOOLS, ...folders.flatMap((p) => CLARIFY_TOOLS.map((tool) => `${tool}(${p}/**)`))];
}

/** A failed run with nothing known about its cost. */
function failed(reason: string, costUsd: number | null = null, turns: number | null = null): ClarifyRun {
  return { outcome: { kind: "failed", reason }, costUsd, turns };
}

/** Pure: the run's result from the agent's output in `--output-format json`, or a failure that says why. */
export function clarifyResult(stdout: string, exitCode: number | null, timedOut: boolean): ClarifyRun {
  if (timedOut) return failed(`the check took longer than ${CLARIFY_MINUTES} minutes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return failed(`the agent gave no readable result (exit ${exitCode})`);
  }
  // Valid JSON that isn't an object (`null`, a number, a list) is no result either.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failed(`the agent gave no readable result (exit ${exitCode})`);
  }
  const envelope = parsed as { result?: unknown; total_cost_usd?: unknown; num_turns?: unknown; is_error?: unknown };
  const costUsd = typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null;
  const turns = typeof envelope.num_turns === "number" ? envelope.num_turns : null;
  if (exitCode !== 0 || envelope.is_error === true || typeof envelope.result !== "string") {
    return failed(`the agent ended with an error (exit ${exitCode})`, costUsd, turns);
  }
  return { outcome: parseClarifyAnswer(envelope.result), costUsd, turns };
}

/** What `waitForAgent` needs of a started process. */
export interface AgentProcess {
  pid?: number;
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
}

/** The most of the agent's output that is kept, per stream. Its answer is a few kilobytes. */
export const CLARIFY_OUTPUT_LIMIT = 4 * 1024 * 1024;

/** How the wait for the agent ended. */
export interface AgentEnd {
  stdout: string;
  /** What the agent printed as errors, kept for the run's private files. */
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** True when a stream passed `CLARIFY_OUTPUT_LIMIT`: the output is cut, so it is no answer. */
  overflowed: boolean;
}

/**
 * Waits for the agent, at most `limitMs`. At the limit it answers at once, as timed out, and only then asks
 * for the process to be ended: a kill that fails or hangs, or a process that never closes, can't hold the tick.
 * Answers once, whichever comes first, and keeps nothing that arrives afterwards. Each stream is kept up to
 * `outputLimit` bytes: past that the agent is ended and the wait answers as overflowed.
 */
export function waitForAgent(
  child: AgentProcess,
  limitMs: number,
  kill: (pid: number) => void,
  onError: (message: string) => void,
  outputLimit = CLARIFY_OUTPUT_LIMIT,
): Promise<AgentEnd> {
  return new Promise((done) => {
    const kept = { stdout: "", stderr: "" };
    let bytes = { stdout: 0, stderr: 0 };
    let answered = false;
    let overflowed = false;
    const endProcess = (why: string) => {
      // Off this turn of the event loop: ending a process tree can itself take time.
      setImmediate(() => {
        try {
          if (child.pid) kill(child.pid);
        } catch (error) {
          onError(`couldn't end the clarify agent ${why}: ${(error as Error).message}`);
        }
      });
    };
    const answer = (exitCode: number | null, timedOut: boolean) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      done({ ...kept, exitCode, timedOut, overflowed });
    };
    const timer = setTimeout(() => {
      answer(null, true);
      endProcess("at its time limit");
    }, limitMs);
    const keep = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      // Nothing is kept after the answer: a process that outlives its kill can't fill the runner's memory.
      if (answered || overflowed) return;
      bytes = { ...bytes, [stream]: bytes[stream] + chunk.length };
      if (bytes[stream] > outputLimit) {
        overflowed = true;
        answer(null, false);
        endProcess("after too much output");
        return;
      }
      kept[stream] += chunk.toString("utf8");
    };
    child.stdout?.on("data", keep("stdout"));
    child.stderr?.on("data", keep("stderr"));
    child.on("error", (error) => {
      // Why it couldn't start goes to the run log: without it the failure can't be told from any other.
      onError(`the clarify agent could not be started: ${error?.message ?? "unknown error"}`);
      answer(null, false);
    });
    child.on("close", (code) => answer(code, false));
  });
}

/**
 * The step's result from how the agent ended. Its output and its error output are saved first, with `save`
 * (as `clarify.json` and `clarify.stderr.txt`): an answer with no record of what the agent said is not
 * acted on, so a failed save is a failed check, whatever the agent answered.
 */
export function clarifyFromEnd(
  ended: AgentEnd,
  save: (name: string, text: string) => void,
  onError: (message: string) => void,
): ClarifyRun {
  try {
    save("clarify.json", ended.stdout);
    save("clarify.stderr.txt", ended.stderr);
  } catch (error) {
    onError(`couldn't save the clarify agent's output: ${(error as Error).message}`);
    return failed("the agent's output couldn't be saved, so its answer is not used");
  }
  if (ended.overflowed) return failed("the agent printed more than the step keeps, so its answer was cut");
  return clarifyResult(ended.stdout, ended.exitCode, ended.timedOut);
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
  // The same private checkouts the builder is kept out of. The runs folder is among them and holds this
  // run's own workspace, so it can't be denied as a folder: the policy hook knows the difference.
  const checkouts = privateCheckoutsFor(runs, process.env, ws.private || undefined);
  const settingsFile = join(ws.root, "clarify-settings.json");
  const folders = [ws.private, join(ROOT, "private"), process.env.FAULTFORGE_PRIVATE_DIR ?? ""];
  writeFileSync(settingsFile, JSON.stringify({ permissions: { deny: clarifyDeny(folders) } }, null, 2));
  const mcpConfigFile = join(ws.root, "clarify-mcp.json");
  writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: {} }, null, 2));
  const args = clarifyArgs(clarifyPrompt(ticketText), settingsFile, mcpConfigFile);
  const env = clarifyEnv(process.env, runId, ws.root, checkouts);
  log("clarify-started", { tools: CLARIFY_TOOLS, budgetUsd: CLARIFY_BUDGET_USD, minutes: CLARIFY_MINUTES });
  let launch: Launch;
  try {
    launch = await sandbox.open(claudeBinary(), args, env, log, () => {});
  } catch (error) {
    log("error", { message: (error as Error).message });
    return failed("the agent that checks a ticket could not be started");
  }
  try {
    const child = spawn(launch.command, launch.args, {
      cwd: ws.lab,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const ended = await waitForAgent(
      child,
      CLARIFY_MINUTES * 60_000,
      launch.kill ?? ((pid: number) => killTree(pid)),
      (message) => log("error", { message }),
    );
    return clarifyFromEnd(
      ended,
      (name, text) => writeFileSync(join(runs, `${runId}.${name}`), text),
      (message) => log("error", { message }),
    );
  } finally {
    await launch.close();
  }
}

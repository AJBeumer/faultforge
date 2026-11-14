/**
 * The headless agent: its instructions, its command line and deny rules, and the launcher that runs it with a
 * time limit and reads its `stream-json` output. Split from factory-tick.ts (#227).
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FactoryConfig, repoConfig } from "./factory-config.ts";
import { killOnExit, killTree } from "./factory-kill.ts";
import type { Logger, TickOptions, Workspace } from "./factory-tick.ts";
import { worktreeFor } from "./factory-workspace.ts";

export { killTree } from "./factory-kill.ts";

export interface AgentRun {
  exitCode: number | null;
  timedOut: boolean;
  resultText: string | null;
  subtype: string | null;
  costUsd: number | null;
  turns: number | null;
  /** The last pull request URL seen in a `gh pr create` step's own result, if the agent opened one. Used
   * when the time limit cuts the run off before it can report a `FACTORY_RESULT` of its own. */
  lastPr?: string | null;
}

/**
 * The pull request URL of exactly `github` from a `gh pr create` step's tool result, or null. The
 * content of a `tool_result` message is either a plain string or a list of `{type: "text", text}` blocks.
 * Other text in the same result (a path, a ticket excerpt the step happened to print) can contain a
 * pull request URL of some other repository; only one of this ticket's own repo counts.
 */
export function prUrlFromToolResult(content: unknown, github: string): string | null {
  const text = Array.isArray(content)
    ? content
        .map((part) =>
          part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "",
        )
        .join("\n")
    : String(content ?? "");
  for (const match of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/g)) {
    if (match[1]?.toLowerCase() === github.toLowerCase()) return match[0];
  }
  return null;
}

/** The instructions added to the agent's system prompt for an unattended run. */
export function agentInstructions(runRoot: string, repoKey: string, number: number, ticketFile: string): string {
  return [
    `You are running unattended: a scheduled task started you for ${repoKey} ticket ${number}. Nobody is watching or will answer, so never ask a question or wait for one.`,
    "Work only this ticket, with the /factory routine. At most three review rounds.",
    `The ticket's text, as the runner checked it, is in ${ticketFile}. Read the ticket from that file only: never with gh issue view, gh api or npm run ticket:ready, which read it live. Don't move the ticket on the project board: the runner tracks it.`,
    'Everything you need from the environment is written here. Don\'t list it (env, printenv and set are blocked); one variable by name, such as echo "$FAULTFORGE_TICKET_FILE", is fine.',
    "In this run, gh api calls about issues, comments or search are blocked. To save and read Qodo's review, use npm run review:wait: it saves every version of the comments and the findings itself.",
    "Run review:wait in the foreground, with the Bash tool's longest timeout (600000 ms) and --timeout 9, and run it again while it exits 1, up to the round's time. Never start it in the background and never schedule a wakeup: ending your turn ends the run, and nobody wakes you. Report FACTORY_RESULT before you stop, whatever happened.",
    "Pass PR bodies, comments and commit messages as files, never inline: write the text with the Write tool to a file in your run folder or the temp folder, then use gh pr create/edit --body-file or git commit -F. The policy hook reads the whole command, so a blocked word quoted in an inline message blocks it.",
    `Your working copies are under ${runRoot}. Never read from or write to the owner's own checkouts elsewhere.`,
    "private/ here is a worktree of the private repo on its own branch: save and commit evidence there, but don't push it. The runner pushes it.",
    "Don't comment on, label or close the ticket, and never reply to, resolve or dismiss a review finding: the runner and the owner do that.",
    "Nothing under any .claude/ folder may change in this run, because it holds your own guardrails. If the ticket needs that, report stuck.",
    "The keys are already in your environment: gh and npm run review:wait pick them up by themselves. Never name, read, print or export them, and don't look for a token file. HTTP tools may only reach the app on localhost.",
    "After you stop, the runner audits what changed (both repos' main, the owner's checkouts, comments and ticket changes during your run, the guardrail files) and stops for help on any surprise.",
    "Finish your final message with exactly one line, and nothing after it:",
    'FACTORY_RESULT {"outcome":"ready|owner-gate|stuck","pr":"<pull request URL or null>","reason":"<one plain sentence>"}',
    "ready: the PR is open, its checks pass, Qodo's review of the head commit is complete with no action-required finding open, and every criterion was checked live.",
    "owner-gate: the PR is otherwise ready, but it changes the reviewer's rules, so the owner must approve a new configuration version.",
    "stuck: anything else. Say exactly what stopped you.",
  ].join("\n");
}

/**
 * The headless agent's command line. Exported so the flags that keep a run closed can be tested: no MCP
 * server of the machine running the tick is reachable (only the empty config in `mcpConfigFile`, with
 * `--strict-mcp-config`), the run's deny rules come from `settingsFile`, the budget is capped (#103), and the
 * wakeup tool is taken away: a headless run ends with the agent's turn, so a scheduled wakeup never fires and
 * only loses the run (#129).
 */
export function agentArgs(input: {
  repoKey: string;
  number: number;
  budget: number;
  settingsFile: string;
  mcpConfigFile: string;
  instructions: string;
  extraDirs: string[];
}): string[] {
  return [
    "-p",
    `/factory ${input.repoKey} ${input.number}`,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--max-budget-usd",
    String(input.budget),
    "--settings",
    input.settingsFile,
    "--mcp-config",
    input.mcpConfigFile,
    "--strict-mcp-config",
    "--disallowedTools",
    "ScheduleWakeup",
    "--append-system-prompt",
    input.instructions,
    ...input.extraDirs,
  ];
}

/** The Claude Code binary: FAULTFORGE_CLAUDE, else the npm install's `claude.exe` on Windows, else `claude`. */
function claudeBinary(): string {
  if (process.env.FAULTFORGE_CLAUDE) return process.env.FAULTFORGE_CLAUDE;
  const exe = join(process.env.APPDATA ?? "", "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe");
  return process.platform === "win32" && existsSync(exe) ? exe : "claude";
}

/** The parts of a `stream-json` line the runner reads. */
interface StreamMessage {
  type?: string;
  message?: {
    content?: {
      type: string;
      name?: string;
      id?: string;
      input?: { command?: string };
      tool_use_id?: string;
      is_error?: boolean;
      content?: unknown;
    }[];
  };
  [key: string]: unknown;
}

/** Deny rules for the agent's session, on top of the policy hook. */
const DENY = [
  "Bash(gh pr merge:*)",
  "Bash(gh pr comment:*)",
  "Bash(gh pr review:*)",
  "Bash(gh pr close:*)",
  "Bash(gh issue comment:*)",
  "Bash(gh issue close:*)",
  "Bash(git push --force:*)",
  "Bash(git push -f:*)",
  "Bash(git push --force-with-lease:*)",
  "Bash(schtasks:*)",
  "Bash(setx:*)",
];

/** A short name for the agent's shell commands worth showing on the timeline, or null. */
export function agentStep(command: string): string | null {
  if (/\bgh\s+pr\s+create\b/.test(command)) return "pr-opened";
  if (/\breview:wait\b/.test(command)) return "review-wait";
  if (/\bgit\b[^\n]*\bpush\b/.test(command)) return "push";
  if (/\bnpm\s+run\s+check\b/.test(command)) return "check";
  if (/\bticket:ready\b/.test(command)) return "ticket-ready";
  if (/\brevert:check\b/.test(command)) return "revert-check";
  return null;
}

/**
 * Runs the agent on one ticket in `ws` (`TickDeps.runAgent`), with the run's budget and time limit, and reads
 * its result from the stream. Its transcript goes to `<runs>/<run id>.agent.jsonl`.
 */
export function runAgent(
  factory: FactoryConfig,
  options: TickOptions,
  runs: string,
  ws: Workspace,
  runId: string,
  repoKey: string,
  number: number,
  ticketFile: string,
  log: Logger,
  /** Told the agent's pid when it starts, and null once it has ended, so the lock only ever names a live agent. */
  onAgent: (pid: number | null) => void = () => {},
): Promise<AgentRun> {
  const { github } = repoConfig(factory, repoKey);
  const settingsFile = join(ws.root, "agent-settings.json");
  writeFileSync(settingsFile, JSON.stringify({ permissions: { deny: DENY } }, null, 2));
  // An empty MCP config, used with --strict-mcp-config: the agent reaches no MCP server of this machine.
  const mcpConfigFile = join(ws.root, "agent-mcp.json");
  writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: {} }, null, 2));
  const transcript = join(runs, `${runId}.agent.jsonl`);
  const extraDirs = Object.values(factory.repos)
    .filter((r) => r.path !== ".")
    .flatMap((r) => ["--add-dir", worktreeFor(ws.lab, r.path)]);
  const args = agentArgs({
    repoKey,
    number,
    budget: options.budget,
    settingsFile,
    mcpConfigFile,
    instructions: agentInstructions(ws.root, repoKey, number, ticketFile),
    extraDirs,
  });
  return new Promise((done) => {
    const child = spawn(claudeBinary(), args, {
      cwd: ws.lab,
      env: {
        ...process.env,
        FAULTFORGE_FACTORY_RUN: runId,
        FAULTFORGE_RUN_ROOT: ws.root,
        FAULTFORGE_TICKET_NUMBER: String(number),
        FAULTFORGE_TICKET_FILE: ticketFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    // Stopping the runner stops the agent, and the lock learns its pid for a kill the runner can't catch.
    const unguard = child.pid ? killOnExit(child.pid) : () => {};
    if (child.pid) onAgent(child.pid);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) killTree(child.pid);
      } catch (error) {
        log("error", { message: `couldn't end the agent at its time limit: ${(error as Error).message}` });
      }
    }, options.minutes * 60_000);
    let buffer = "";
    let final: Record<string, unknown> | null = null;
    let lastPr: string | null = null;
    const commands = new Map<string, string>();
    const onLine = (line: string) => {
      if (!line.trim()) return;
      appendFileSync(transcript, `${JSON.stringify({ t: new Date().toISOString(), line })}\n`);
      let message: StreamMessage;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.type === "result") final = message;
      for (const part of message.message?.content ?? []) {
        if (part.type === "tool_use" && part.name === "Bash") {
          const command = String(part.input?.command ?? "");
          const step = agentStep(command);
          if (step) {
            commands.set(part.id ?? "", step);
            log("agent-step", { step, command: command.slice(0, 120) });
          }
        } else if (part.type === "tool_result" && commands.has(part.tool_use_id ?? "")) {
          // No output here: the event log can be public (an Actions log or artifact). The full
          // output stays in the agent transcript, which only goes to the private repo.
          const step = commands.get(part.tool_use_id ?? "");
          log("agent-step-result", { step, error: Boolean(part.is_error) });
          if (step === "pr-opened" && !part.is_error) {
            const url = prUrlFromToolResult(part.content, github);
            if (url) lastPr = url;
          }
        }
      }
    };
    child.stdout.setEncoding("utf8"); // decoded whole, never split mid-character (audit N-12)
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(onLine);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) =>
      appendFileSync(transcript, `${JSON.stringify({ t: new Date().toISOString(), stderr: chunk })}\n`),
    );
    let settled = false;
    // A binary that can't start emits "error" and maybe never "close": report it, don't hang or crash.
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unguard();
      onAgent(null);
      done({
        exitCode: null,
        timedOut: false,
        resultText: null,
        subtype: `could not start the agent: ${error.message}`,
        costUsd: null,
        turns: null,
        lastPr: null,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unguard();
      onAgent(null);
      if (buffer) onLine(buffer);
      const result = final as Record<string, unknown> | null;
      done({
        exitCode: code,
        timedOut,
        resultText: typeof result?.result === "string" ? result.result : null,
        subtype: typeof result?.subtype === "string" ? result.subtype : null,
        costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
        turns: typeof result?.num_turns === "number" ? result.num_turns : null,
        lastPr,
      });
    });
  });
}

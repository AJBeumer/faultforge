/**
 * One tick of the unattended factory. A Windows scheduled task runs it every 10 minutes:
 *
 *   npm run factory:tick                     # take the oldest ready-for-agent ticket, if any
 *   npm run factory:tick -- --minutes 120 --budget 25
 *
 * One tick takes at most one ticket, across every repo in `factory.json`:
 *  1. Lock, so only one run happens at a time. Busy or nothing labelled: log it and exit 0.
 *  2. Pick the ticket whose `ready-for-agent` label was added longest ago.
 *  3. Refuse it unless the repo owner added that label (read from the issue's events), so a stranger's
 *     ticket text never reaches the agent as instructions. Refuse it if it isn't ready.
 *  4. Claim it: `agent-working`, and a comment on the ticket.
 *  5. Fresh worktrees of every repo from `origin/main`, and of the private repo on its own branch,
 *     laid out like the owner's folders, so the owner's working trees are never touched.
 *  6. Run `claude -p "/factory <repo> <N>"` there, with a dollar budget, a time limit, deny rules, and
 *     the factory policy hook switched on.
 *  7. Don't take the agent's word: check the PR is open in the ticket's repo, its checks passed, Qodo's
 *     review of its head commit is complete, and `main` didn't move during the run.
 *  8. Label the ticket `agent-done` or `agent-needs-help`, comment why, push the run log to the private
 *     repo, and clean up (worktrees are kept when the run needs help, for inspection).
 *
 * Every step is appended with a UTC time to `<runs>/<run id>.jsonl` as it happens, and saved under
 * `<evidence>/factory-runs/`. `npm run factory:timeline` prints it as a table.
 *
 * Needs GH_TOKEN (or GH_TOKEN_FILE) and QODO_KEY_FILE in the environment. Never merges.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type FactoryConfig, loadFactory, repoConfig } from "./factory-config.ts";
import { telltales } from "./neutral.ts";
import { checkTicket } from "./ticket-ready.ts";

export const LABELS = {
  ready: "ready-for-agent",
  working: "agent-working",
  done: "agent-done",
  help: "agent-needs-help",
} as const;

const LAB_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// ---------------------------------------------------------------------------------------------
// Pure decisions (unit tested)

export interface IssueEvent {
  event: string;
  created_at: string;
  actor?: { login: string } | null;
  label?: { name: string } | null;
}

/** Who added `label` most recently, and when, or null if the events never show it being added. */
export function lastLabelled(events: IssueEvent[], label: string): { by: string; at: string } | null {
  const added = events.filter((e) => e.event === "labeled" && e.label?.name === label);
  const last = added.sort((a, b) => a.created_at.localeCompare(b.created_at)).pop();
  return last ? { by: last.actor?.login ?? "(unknown)", at: last.created_at } : null;
}

export interface Candidate {
  repoKey: string;
  github: string;
  number: number;
  title: string;
  labelledAt: string;
  labelledBy: string;
}

/** The ticket labelled longest ago; ties go to the lower repo key, then the lower number. */
export function oldest(candidates: Candidate[]): Candidate | undefined {
  return [...candidates].sort(
    (a, b) => a.labelledAt.localeCompare(b.labelledAt) || a.repoKey.localeCompare(b.repoKey) || a.number - b.number,
  )[0];
}

export interface AgentResult {
  outcome: "ready" | "owner-gate" | "stuck";
  pr: string | null;
  reason: string;
}

/** The agent's last `FACTORY_RESULT {...}` line, or null if it gave none or it doesn't parse. */
export function parseAgentResult(text: string | null | undefined): AgentResult | null {
  const lines = [...(text ?? "").matchAll(/^\s*FACTORY_RESULT\s+(\{.*\})\s*$/gm)];
  const last = lines.pop();
  if (!last?.[1]) return null;
  try {
    const value = JSON.parse(last[1]);
    if (!["ready", "owner-gate", "stuck"].includes(value.outcome)) return null;
    return {
      outcome: value.outcome,
      pr: typeof value.pr === "string" && value.pr ? value.pr : null,
      reason: String(value.reason ?? "").trim() || "(no reason given)",
    };
  } catch {
    return null;
  }
}

/** The PR number when `url` is a pull request of exactly this repo, else null. */
export function prNumber(url: string | null, github: string): number | null {
  const match = url?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/);
  return match?.[1]?.toLowerCase() === github.toLowerCase() ? Number(match[2]) : null;
}

export interface AgentRun {
  exitCode: number | null;
  timedOut: boolean;
  resultText: string | null;
  subtype: string | null;
  costUsd: number | null;
  turns: number | null;
}

export interface Verification {
  /** Problems that stop a PR from counting as delivered; empty when it checks out. */
  problems: string[];
}

export interface Finish {
  label: typeof LABELS.done | typeof LABELS.help;
  reason: string;
  pr: string | null;
}

/**
 * What the run delivered, from the agent's own report and the runner's independent checks. Anything the
 * runner can't confirm is a stop for the owner, never a success.
 */
export function settle(
  agent: AgentRun,
  result: AgentResult | null,
  verify: (pr: number) => Verification,
  github: string,
  minutes: number,
): Finish {
  if (agent.timedOut) return { label: LABELS.help, reason: `hit the time limit of ${minutes} minutes`, pr: null };
  if (!result) {
    const how = agent.subtype && agent.subtype !== "success" ? ` (${agent.subtype})` : "";
    return {
      label: LABELS.help,
      reason: `the agent ended without a result, exit code ${agent.exitCode}${how}`,
      pr: null,
    };
  }
  if (result.outcome === "stuck") return { label: LABELS.help, reason: result.reason, pr: result.pr };
  const number = prNumber(result.pr, github);
  if (number === null) {
    return {
      label: LABELS.help,
      reason: `the agent reported "${result.outcome}" without a pull request in ${github}`,
      pr: null,
    };
  }
  const { problems } = verify(number);
  if (problems.length) {
    return {
      label: LABELS.help,
      reason: `the agent reported "${result.outcome}", but ${problems.join("; ")}`,
      pr: result.pr,
    };
  }
  return {
    label: LABELS.done,
    reason:
      result.outcome === "ready"
        ? "the pull request is ready for the owner to merge"
        : `waiting for the owner: ${result.reason}`,
    pr: result.pr,
  };
}

/** Problems with a PR's checks: none may be pending or failed, and at least one must have run. */
export function checkProblems(
  rollup: { name?: string; context?: string; status?: string; conclusion?: string; state?: string }[],
): string[] {
  if (!rollup.length) return ["no checks ran on the pull request"];
  const bad = rollup.filter((c) => {
    const state = (c.conclusion || c.state || c.status || "").toUpperCase();
    return !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state);
  });
  return bad.length
    ? [
        `checks not green: ${bad.map((c) => `${c.name ?? c.context} ${c.conclusion || c.state || c.status}`).join(", ")}`,
      ]
    : [];
}

/** Text for a ticket comment; in a reviewed repo, anything that would give the lab away is replaced. */
export function safeText(text: string, reviewed: boolean): string {
  if (!reviewed || !telltales(text).length) return text;
  return "The details are in the run log.";
}

/** A sortable run id from the start time and the ticket, e.g. `20261109-093012-target-18`. */
export function runIdFor(now: Date, repoKey: string, number: number): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${repoKey}-${number}`;
}

/** The instructions added to the agent's system prompt for an unattended run. */
export function agentInstructions(runRoot: string, repoKey: string, number: number): string {
  return [
    `You are running unattended: a scheduled task started you for ${repoKey} ticket ${number}. Nobody is watching or will answer, so never ask a question or wait for one.`,
    "Work only this ticket, with the /factory routine. At most three review rounds.",
    `Your working copies are under ${runRoot}. Never read from or write to the owner's own checkouts elsewhere.`,
    "private/ here is a worktree of the private repo on its own branch: save and commit evidence there, but don't push it. The runner pushes it.",
    "Don't comment on, label or close the ticket, and never reply to, resolve or dismiss a review finding: the runner and the owner do that.",
    "Finish your final message with exactly one line, and nothing after it:",
    'FACTORY_RESULT {"outcome":"ready|owner-gate|stuck","pr":"<pull request URL or null>","reason":"<one plain sentence>"}',
    "ready: the PR is open, its checks pass, Qodo's review of the head commit is complete with no action-required finding open, and every criterion was checked live.",
    "owner-gate: the PR is otherwise ready, but it changes the reviewer's rules, so the owner must approve a new configuration version.",
    "stuck: anything else. Say exactly what stopped you.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The tick, with every side effect behind `TickDeps` so the stop paths can be tested with fakes.

export interface Workspace {
  /** Folder holding this run's worktrees. */
  root: string;
  /** This repo's worktree, where the agent starts. */
  lab: string;
  /** The private repo's worktree, on its own branch. */
  private: string;
  /** Each repo's `main` commit when the run started. */
  mainAtStart: Record<string, string>;
}

export interface TickDeps {
  now(): Date;
  print(line: string): void;
  lock(): { acquired: boolean; release(): void; note?: string };
  /** Open issues (not PRs) with the label, in one repo. */
  labelled(github: string, label: string): { number: number; title: string }[];
  events(github: string, number: number): IssueEvent[];
  ready(repoKey: string, number: number): { title: string; problems: string[] };
  relabel(github: string, number: number, remove: string[], add: string[]): void;
  comment(github: string, number: number, body: string): void;
  workspace(runId: string): Workspace;
  runAgent(ws: Workspace, runId: string, repoKey: string, number: number, log: Logger): Promise<AgentRun>;
  verifyPr(ws: Workspace, repoKey: string, pr: number): Verification;
  mainSha(github: string): string;
  /** Saves the run log (and the agent's transcript) to the private repo and pushes it. */
  saveEvidence(runId: string, ws: Workspace | null): string;
  cleanup(ws: Workspace): void;
  /** Appends one event to the live run log. */
  record(runId: string, event: object): void;
}

export type Logger = (event: string, detail?: Record<string, unknown>) => void;

export interface TickOptions {
  minutes: number;
  budget: number;
}

export type TickOutcome = "busy" | "idle" | "refused" | "not-ready" | "done" | "needs-help";

export async function tick(factory: FactoryConfig, deps: TickDeps, options: TickOptions): Promise<TickOutcome> {
  const lock = deps.lock();
  if (!lock.acquired) {
    deps.print(`${deps.now().toISOString()} busy: another run holds the lock${lock.note ? ` (${lock.note})` : ""}`);
    return "busy";
  }
  let runId: string | null = null;
  let claimed: Candidate | null = null;
  let ws: Workspace | null = null;
  const log: Logger = (event, detail = {}) => {
    const entry = { t: deps.now().toISOString(), event, ...detail };
    deps.print(`${entry.t} ${event}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
    if (runId) deps.record(runId, entry);
  };
  try {
    if (lock.note) log("lock", { note: lock.note });
    const candidates: Candidate[] = [];
    for (const [repoKey, repo] of Object.entries(factory.repos)) {
      for (const issue of deps.labelled(repo.github, LABELS.ready)) {
        const added = lastLabelled(deps.events(repo.github, issue.number), LABELS.ready);
        if (!added) continue;
        candidates.push({
          repoKey,
          github: repo.github,
          number: issue.number,
          title: issue.title,
          labelledAt: added.at,
          labelledBy: added.by,
        });
      }
    }
    const pick = oldest(candidates);
    if (!pick) {
      log("idle", { labelled: 0 });
      return "idle";
    }
    runId = runIdFor(deps.now(), pick.repoKey, pick.number);
    const reviewed = repoConfig(factory, pick.repoKey).guard === "reviewed";
    const say = (body: string) => deps.comment(pick.github, pick.number, safeText(body, reviewed));
    log("picked", {
      repo: pick.repoKey,
      ticket: pick.number,
      title: pick.title,
      labelledAt: pick.labelledAt,
      labelledBy: pick.labelledBy,
      waiting: candidates.length - 1,
    });

    const owner = pick.github.split("/")[0] ?? "";
    if (pick.labelledBy.toLowerCase() !== owner.toLowerCase()) {
      deps.relabel(pick.github, pick.number, [LABELS.ready], []);
      say(
        `Not started. The \`${LABELS.ready}\` label was added by ${pick.labelledBy}, and only the repository owner can start an agent run. The label has been removed.`,
      );
      log("refused", { reason: `label added by ${pick.labelledBy}, not the owner ${owner}` });
      deps.saveEvidence(runId, null);
      return "refused";
    }

    const readiness = deps.ready(pick.repoKey, pick.number);
    if (readiness.problems.length) {
      deps.relabel(pick.github, pick.number, [LABELS.ready], [LABELS.help]);
      say(
        `Not started: this ticket isn't ready yet.\n\n${readiness.problems.map((p) => `- ${p}`).join("\n")}\n\nFix the ticket and add \`${LABELS.ready}\` again.`,
      );
      log("not-ready", { problems: readiness.problems });
      deps.saveEvidence(runId, null);
      return "not-ready";
    }

    deps.relabel(pick.github, pick.number, [LABELS.ready], [LABELS.working]);
    claimed = pick;
    say(
      `Picked up by scheduled agent run \`${runId}\`. Limits: ${options.minutes} minutes, three review rounds. It will report here when it stops; merging stays with the owner.`,
    );
    log("claimed", { limits: { minutes: options.minutes, budgetUsd: options.budget, reviewRounds: 3 } });

    ws = deps.workspace(runId);
    log("workspace", { root: ws.root, mainAtStart: ws.mainAtStart });

    log("agent-started", { command: `/factory ${pick.repoKey} ${pick.number}` });
    const agent = await deps.runAgent(ws, runId, pick.repoKey, pick.number, log);
    const result = parseAgentResult(agent.resultText);
    log("agent-finished", {
      exitCode: agent.exitCode,
      timedOut: agent.timedOut,
      subtype: agent.subtype,
      costUsd: agent.costUsd,
      turns: agent.turns,
      result,
    });

    const workspace = ws;
    const finish = settle(
      agent,
      result,
      (pr) => {
        const verification = deps.verifyPr(workspace, pick.repoKey, pr);
        const before = workspace.mainAtStart[pick.repoKey];
        const now = deps.mainSha(pick.github);
        if (before && now !== before)
          verification.problems.push(`main moved during the run (${before.slice(0, 7)} → ${now.slice(0, 7)})`);
        log("verified", { pr, problems: verification.problems });
        return verification;
      },
      pick.github,
      options.minutes,
    );
    deps.relabel(pick.github, pick.number, [LABELS.working], [finish.label]);
    const prLine = finish.pr ? `\n\nPull request: ${finish.pr}` : "";
    say(
      finish.label === LABELS.done
        ? `Agent run \`${runId}\` finished: ${finish.reason}.${prLine}`
        : `Agent run \`${runId}\` stopped and needs help: ${finish.reason}.${prLine}`,
    );
    log("finished", { label: finish.label, reason: finish.reason, pr: finish.pr });
    log("saved", { evidence: deps.saveEvidence(runId, ws) });
    if (finish.label === LABELS.done) deps.cleanup(ws);
    else log("kept", { root: ws.root });
    return finish.label === LABELS.done ? "done" : "needs-help";
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    log("error", { message });
    if (claimed) {
      try {
        deps.relabel(claimed.github, claimed.number, [LABELS.working], [LABELS.help]);
        const reviewed = repoConfig(factory, claimed.repoKey).guard === "reviewed";
        deps.comment(
          claimed.github,
          claimed.number,
          safeText(`Agent run \`${runId}\` stopped and needs help: the runner failed (${message}).`, reviewed),
        );
      } catch (inner) {
        log("error", { message: `couldn't report on the ticket: ${inner instanceof Error ? inner.message : inner}` });
      }
    }
    if (runId) {
      try {
        deps.saveEvidence(runId, ws);
      } catch {
        // The live log under the runs folder still has everything.
      }
    }
    return "needs-help";
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------------------------
// Real side effects

function runsDir(): string {
  return resolve(process.env.FAULTFORGE_RUNS_DIR ?? join(LAB_ROOT, "..", "faultforge-runs"));
}

function gh(...args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function npm(cwd: string, ...args: string[]): { status: number | null; output: string } {
  // npm is a .cmd file on Windows, which only a shell can start. The arguments are fixed strings.
  const result = spawnSync("npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid: number) {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  else process.kill(-pid, "SIGKILL");
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

function realDeps(factory: FactoryConfig, options: TickOptions): TickDeps {
  const runs = runsDir();
  mkdirSync(runs, { recursive: true });
  const evidenceInPrivate = relative("private", factory.evidence); // e.g. raw-artifacts
  const privateRepo = join(LAB_ROOT, "private");

  /** Worktree folder for a repo: its configured path, resolved from the lab's worktree. */
  const worktreeFor = (labWt: string, path: string) => resolve(labWt, path);

  return {
    now: () => new Date(),
    print: (line) => console.log(line),
    lock() {
      const file = join(runs, "factory.lock");
      const take = () =>
        writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
      const release = () => rmSync(file, { force: true });
      try {
        take();
        return { acquired: true, release };
      } catch {
        let held: { pid?: number; at?: string } = {};
        try {
          held = JSON.parse(readFileSync(file, "utf8"));
        } catch {
          // An unreadable lock is treated as stale below.
        }
        if (held.pid && pidAlive(held.pid))
          return { acquired: false, release: () => {}, note: `pid ${held.pid} since ${held.at}` };
        rmSync(file, { force: true });
        take();
        return {
          acquired: true,
          release,
          note: `took over a stale lock from pid ${held.pid ?? "?"} (${held.at ?? "unknown time"})`,
        };
      }
    },
    labelled: (github, label) =>
      (
        JSON.parse(
          gh(
            "api",
            "--paginate",
            "--slurp",
            `repos/${github}/issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`,
          ),
        ) as {
          number: number;
          title: string;
          pull_request?: unknown;
        }[][]
      )
        .flat()
        .filter((i) => !i.pull_request),
    events: (github, number) =>
      (
        JSON.parse(
          gh("api", "--paginate", "--slurp", `repos/${github}/issues/${number}/events?per_page=100`),
        ) as IssueEvent[][]
      ).flat(),
    ready: (repoKey, number) => checkTicket(factory, repoKey, number),
    relabel(github, number, remove, add) {
      for (const label of remove) {
        try {
          gh("api", "-X", "DELETE", `repos/${github}/issues/${number}/labels/${encodeURIComponent(label)}`);
        } catch {
          // Already gone.
        }
      }
      if (add.length) gh("issue", "edit", String(number), "--repo", github, ...add.flatMap((l) => ["--add-label", l]));
    },
    comment: (github, number, body) => {
      gh("issue", "comment", String(number), "--repo", github, "--body", body);
    },
    workspace(runId) {
      const root = join(runs, runId);
      const lab = join(root, basename(LAB_ROOT));
      const mainAtStart: Record<string, string> = {};
      mkdirSync(root, { recursive: true });
      for (const [key, repo] of Object.entries(factory.repos)) {
        const source = resolve(LAB_ROOT, repo.path);
        const target = repo.path === "." ? lab : worktreeFor(lab, repo.path);
        git(source, "fetch", "--quiet", "origin", "main");
        mainAtStart[key] = git(source, "rev-parse", "origin/main");
        mkdirSync(dirname(target), { recursive: true });
        git(source, "worktree", "add", "--detach", target, "origin/main");
      }
      const priv = join(lab, "private");
      git(privateRepo, "fetch", "--quiet", "origin", "main");
      git(privateRepo, "worktree", "add", "-b", `run-${runId}`, priv, "origin/main");
      for (const repo of Object.values(factory.repos)) {
        const dir = repo.path === "." ? lab : worktreeFor(lab, repo.path);
        if (!existsSync(join(dir, "package.json"))) continue;
        const install = npm(dir, "ci", "--no-audit", "--no-fund");
        if (install.status !== 0) throw new Error(`npm ci failed in ${dir}: ${install.output.slice(-400)}`);
      }
      return { root, lab, private: priv, mainAtStart };
    },
    runAgent(ws, runId, repoKey, number, log) {
      const settingsFile = join(ws.root, "agent-settings.json");
      writeFileSync(settingsFile, JSON.stringify({ permissions: { deny: DENY } }, null, 2));
      const transcript = join(runs, `${runId}.agent.jsonl`);
      const extraDirs = Object.values(factory.repos)
        .filter((r) => r.path !== ".")
        .flatMap((r) => ["--add-dir", worktreeFor(ws.lab, r.path)]);
      const args = [
        "-p",
        `/factory ${repoKey} ${number}`,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        "--max-budget-usd",
        String(options.budget),
        "--settings",
        settingsFile,
        "--append-system-prompt",
        agentInstructions(ws.root, repoKey, number),
        ...extraDirs,
      ];
      return new Promise((done) => {
        const child = spawn(claudeBinary(), args, {
          cwd: ws.lab,
          env: { ...process.env, FAULTFORGE_FACTORY_RUN: runId, FAULTFORGE_RUN_ROOT: ws.root },
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) killTree(child.pid);
        }, options.minutes * 60_000);
        let buffer = "";
        let final: Record<string, unknown> | null = null;
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
                log("agent-step", { step, command: command.slice(0, 200) });
              }
            } else if (part.type === "tool_result" && commands.has(part.tool_use_id ?? "")) {
              const text = Array.isArray(part.content)
                ? part.content.map((c: { text?: string }) => c.text ?? "").join("")
                : String(part.content ?? "");
              log("agent-step-result", {
                step: commands.get(part.tool_use_id ?? ""),
                error: Boolean(part.is_error),
                output: text.slice(-300),
              });
            }
          }
        };
        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          lines.forEach(onLine);
        });
        child.stderr.on("data", (chunk: Buffer) =>
          appendFileSync(
            transcript,
            `${JSON.stringify({ t: new Date().toISOString(), stderr: chunk.toString("utf8") })}\n`,
          ),
        );
        child.on("close", (code) => {
          clearTimeout(timer);
          if (buffer) onLine(buffer);
          const result = final as Record<string, unknown> | null;
          done({
            exitCode: code,
            timedOut,
            resultText: typeof result?.result === "string" ? result.result : null,
            subtype: typeof result?.subtype === "string" ? result.subtype : null,
            costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
            turns: typeof result?.num_turns === "number" ? result.num_turns : null,
          });
        });
      });
    },
    verifyPr(ws, repoKey, pr) {
      const { github } = repoConfig(factory, repoKey);
      const view = JSON.parse(
        gh("pr", "view", String(pr), "--repo", github, "--json", "state,headRefOid,statusCheckRollup"),
      );
      const problems: string[] = [];
      if (view.state !== "OPEN") problems.push(`the pull request is ${String(view.state).toLowerCase()}, not open`);
      problems.push(...checkProblems(view.statusCheckRollup ?? []));
      // review:wait runs in the run's worktree, so its evidence lands in the run's private branch.
      const review = npm(ws.lab, "run", "-s", "review:wait", "--", repoKey, String(pr), "--timeout", "5");
      const meaning: Record<number, string> = {
        1: "Qodo's review of the head commit isn't complete",
        2: "review:wait couldn't run",
        3: "Qodo skipped the review of the head commit",
      };
      if (review.status !== 0) problems.push(meaning[review.status ?? 2] ?? `review:wait exited ${review.status}`);
      return { problems };
    },
    mainSha: (github) => gh("api", `repos/${github}/commits/main`, "--jq", ".sha").trim(),
    record(runId, event) {
      appendFileSync(join(runs, `${runId}.jsonl`), `${JSON.stringify(event)}\n`);
    },
    saveEvidence(runId, ws) {
      let priv = ws?.private;
      let temporary = false;
      if (!priv) {
        priv = join(runs, runId, "private");
        mkdirSync(dirname(priv), { recursive: true });
        git(privateRepo, "fetch", "--quiet", "origin", "main");
        git(privateRepo, "worktree", "add", "-b", `run-${runId}`, priv, "origin/main");
        temporary = true;
      }
      const dir = join(priv, evidenceInPrivate, "factory-runs");
      mkdirSync(dir, { recursive: true });
      for (const suffix of [".jsonl", ".agent.jsonl"]) {
        const file = join(runs, `${runId}${suffix}`);
        if (existsSync(file)) copyFileSync(file, join(dir, `${runId}${suffix}`));
      }
      git(priv, "add", "-A");
      if (git(priv, "status", "--porcelain"))
        git(priv, "commit", "--quiet", "-m", `Factory run ${runId}: log and evidence`);
      git(priv, "fetch", "--quiet", "origin", "main");
      git(priv, "rebase", "--quiet", "origin/main");
      git(priv, "push", "--quiet", "origin", "HEAD:main");
      if (temporary) {
        git(privateRepo, "worktree", "remove", "--force", priv);
        git(privateRepo, "branch", "-D", `run-${runId}`);
        rmSync(join(runs, runId), { recursive: true, force: true });
      }
      return join(factory.evidence, "factory-runs", `${runId}.jsonl`);
    },
    cleanup(ws) {
      // The private worktree sits inside the lab's worktree: remove it first, through its own repo.
      git(privateRepo, "worktree", "remove", "--force", ws.private);
      git(privateRepo, "branch", "-D", `run-${basename(ws.root)}`);
      for (const repo of Object.values(factory.repos)) {
        if (repo.path === ".") continue;
        git(resolve(LAB_ROOT, repo.path), "worktree", "remove", "--force", worktreeFor(ws.lab, repo.path));
      }
      git(LAB_ROOT, "worktree", "remove", "--force", ws.lab);
      rmSync(ws.root, { recursive: true, force: true });
    },
  };
}

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

function option(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  const value = index >= 0 ? Number(args[index + 1]) : fallback;
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`usage: npm run factory:tick -- [--minutes N] [--budget USD]   (${name} must be a positive number)`);
    process.exit(2);
  }
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const options = { minutes: option(args, "--minutes", 120), budget: option(args, "--budget", 25) };
  if (!process.env.GH_TOKEN && process.env.GH_TOKEN_FILE)
    process.env.GH_TOKEN = readFileSync(process.env.GH_TOKEN_FILE, "utf8").trim();
  if (!process.env.GH_TOKEN) {
    console.error("factory:tick needs GH_TOKEN or GH_TOKEN_FILE.");
    process.exit(2);
  }
  const factory = loadFactory();
  const outcome = await tick(factory, realDeps(factory, options), options);
  process.exit(outcome === "needs-help" ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();

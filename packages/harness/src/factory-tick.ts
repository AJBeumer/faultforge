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
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  if (agent.exitCode !== 0 || (agent.subtype !== null && agent.subtype !== "success")) {
    return {
      label: LABELS.help,
      reason: `the agent reported "${result.outcome}" but exited with code ${agent.exitCode} (${agent.subtype ?? "no result"})`,
      pr: result.pr,
    };
  }
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

export interface Provenance {
  author: string;
  /** Everyone who edited the ticket's body. */
  editors: string[];
  /** Everyone who commented on it. */
  commenters: string[];
  /** Everyone who edited one of its comments: a comment's text is theirs too. */
  commentEditors?: string[];
  /** Parts that couldn't be read completely, such as a comment with more edits than one page. */
  incomplete?: string[];
}

/**
 * Why a ticket's text can't be trusted as the agent's instructions, or an empty list. The label shows
 * the owner chose the ticket, not who wrote what the agent will read.
 */
export function provenanceProblems(p: Provenance, owner: string): string[] {
  const others = (logins: string[]) => [...new Set(logins.filter((l) => l.toLowerCase() !== owner.toLowerCase()))];
  const problems: string[] = [];
  if (others([p.author]).length) problems.push(`written by ${p.author}`);
  if (others(p.editors).length) problems.push(`edited by ${others(p.editors).join(", ")}`);
  if (others(p.commenters).length) problems.push(`commented on by ${others(p.commenters).join(", ")}`);
  const commentEditors = others(p.commentEditors ?? []);
  if (commentEditors.length) problems.push(`a comment edited by ${commentEditors.join(", ")}`);
  if (p.incomplete?.length) problems.push(`not fully readable: ${p.incomplete.join(", ")}`);
  return problems;
}

/** The ticket as the agent will read it, and who wrote each part. */
export interface TicketSnapshot {
  /** Title, body and every comment, as one Markdown text. */
  text: string;
  provenance: Provenance;
  /** Who edited the body and how many edits each comment has: an edit undone later still shows here. */
  history?: string;
}

/**
 * Why the ticket can't be trusted after the run: anything changed since the snapshot the agent worked
 * from, or someone else's text is now on it. Empty when it is exactly as it was.
 */
export function ticketChangeProblems(before: TicketSnapshot, after: TicketSnapshot, owner: string): string[] {
  const problems = provenanceProblems(after.provenance, owner).map((p) => `the ticket is now ${p}`);
  if (after.text !== before.text) problems.push("the ticket's text changed during the run");
  else if ((after.history ?? "") !== (before.history ?? "")) {
    problems.push("the ticket was edited during the run, even though its text is back as it was");
  }
  return problems;
}

/** The secret names whose values must never reach a log. */
export const SECRET_NAMES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "QODO_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
];

/** Replaces every secret value from the environment (8 characters or longer) with three stars. */
export function redact(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  for (const name of SECRET_NAMES) {
    const value = env[name]?.trim();
    if (value && value.length >= 8) out = out.split(value).join("***");
  }
  return out;
}

/** Text for a ticket comment; in a reviewed repo, anything that would give the lab away is replaced. */
export function safeText(text: string, reviewed: boolean): string {
  if (!reviewed || !telltales(text).length) return text;
  return "The details are in the run log.";
}

/**
 * Why a workspace's `.claude/settings.json` isn't safe for an unattended run, or an empty list. Both the
 * guard hook and the factory policy hook must run before every shell command and file edit.
 */
/** True when a hook command runs exactly this repo's hook file with node, not merely mentions it. */
export function runsHook(command: string, file: string): boolean {
  const expected = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${file}"`;
  return command.trim().replace(/\\/g, "/") === expected;
}

export function hookProblems(settingsText: string): string[] {
  let hooks: { matcher?: string; hooks?: { command?: string }[] }[] = [];
  try {
    hooks = JSON.parse(settingsText).hooks?.PreToolUse ?? [];
  } catch {
    return ["its settings.json is missing or unreadable"];
  }
  const problems: string[] = [];
  for (const hook of ["guard-target.ts", "factory-policy.ts"]) {
    for (const tool of ["Bash", "PowerShell", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      const covered = hooks.some(
        (h) =>
          (!h.matcher || h.matcher === "*" || new RegExp(`^(${h.matcher})$`).test(tool)) &&
          (h.hooks ?? []).some((c) => runsHook(c.command ?? "", hook)),
      );
      if (!covered) problems.push(`${hook} doesn't run before ${tool}`);
    }
  }
  return problems;
}

/** Titles of the action-required findings still open in a `review:wait` record. */
export function openActionRequired(record: {
  openFindings?: { severity?: string | null; title?: string | null }[];
}): string[] {
  return (record.openFindings ?? [])
    .filter((f) => f.severity === "action_required")
    .map((f) => f.title ?? "(untitled)");
}

export interface WindowActivity {
  /** Comments on any issue or PR, and inline review comments, by the agent's login. */
  comments: { user: string; created_at: string; url: string }[];
  /** Events on the ticket, such as labels or closing. */
  ticketEvents: IssueEvent[];
  /** Submitted PR reviews (approve, request changes, comment), which leave no comment of their own. */
  reviews?: { user: string; created_at: string; url: string }[];
}

/** The key for the private evidence repo in `Workspace.mainAtStart`. */
export const PRIVATE_KEY = "(private)";

/**
 * Things the agent's GitHub identity did during the run that only the runner or the owner may do: a
 * comment anywhere (a reply to a review finding, a PR comment) or a change to the ticket. The agent
 * runs as the owner, so anything by that login inside the agent's window counts.
 */
export function windowProblems(activity: WindowActivity, login: string, from: string, to: string): string[] {
  // GitHub records whole seconds and the run records milliseconds: widen the window to whole seconds,
  // so an action in the same second as the agent's start or end still counts.
  const start = Math.floor(Date.parse(from) / 1000) * 1000;
  const end = Math.ceil(Date.parse(to) / 1000) * 1000;
  const inWindow = (at: string) => Date.parse(at) >= start && Date.parse(at) <= end;
  const mine = (user: string | undefined) => user?.toLowerCase() === login.toLowerCase();
  const problems: string[] = [];
  for (const c of activity.comments) {
    if (mine(c.user) && inWindow(c.created_at)) problems.push(`a comment was posted during the run (${c.url})`);
  }
  for (const r of activity.reviews ?? []) {
    if (mine(r.user) && inWindow(r.created_at)) problems.push(`a PR review was submitted during the run (${r.url})`);
  }
  for (const e of activity.ticketEvents) {
    if (inWindow(e.created_at))
      problems.push(`the ticket was changed during the run (${e.event} by ${e.actor?.login ?? "?"})`);
  }
  return problems;
}

/** Where a run's log is saved, relative to this repo. */
export function evidenceFile(factory: FactoryConfig, runId: string): string {
  return `${factory.evidence}/factory-runs/${runId}.jsonl`;
}

/** A sortable run id from the start time and the ticket, e.g. `20261109-093012-target-18`. */
export function runIdFor(now: Date, repoKey: string, number: number): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${repoKey}-${number}`;
}

/** The instructions added to the agent's system prompt for an unattended run. */
export function agentInstructions(runRoot: string, repoKey: string, number: number, ticketFile: string): string {
  return [
    `You are running unattended: a scheduled task started you for ${repoKey} ticket ${number}. Nobody is watching or will answer, so never ask a question or wait for one.`,
    "Work only this ticket, with the /factory routine. At most three review rounds.",
    `The ticket's text, as the runner checked it, is in ${ticketFile}. Read the ticket from that file only: never with gh issue view or gh api, which are blocked for this ticket in this run.`,
    "In this run, gh api calls about issues, comments or search are blocked. To save and read Qodo's review, use npm run review:wait: it saves every version of the comments and the findings itself.",
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
  /** Fingerprints taken before the agent starts, compared after it stops: the owner's checkouts and the guardrail files. */
  fingerprints: Record<string, string>;
}

export interface TickDeps {
  now(): Date;
  print(line: string): void;
  lock(): { acquired: boolean; release(): void; note?: string };
  /** Open issues (not PRs) with the label, in one repo. */
  labelled(github: string, label: string): { number: number; title: string }[];
  events(github: string, number: number): IssueEvent[];
  ready(repoKey: string, number: number): { title: string; problems: string[] };
  /** The ticket's full text and who wrote, edited and commented on it: its text becomes the agent's instructions. */
  snapshot(github: string, number: number): TicketSnapshot;
  /** Writes the checked ticket text into the workspace for the agent, and returns its path. */
  writeTicket(ws: Workspace, text: string): string;
  relabel(github: string, number: number, remove: string[], add: string[]): void;
  comment(github: string, number: number, body: string): void;
  workspace(runId: string): Workspace;
  runAgent(
    ws: Workspace,
    runId: string,
    repoKey: string,
    number: number,
    ticketFile: string,
    log: Logger,
  ): Promise<AgentRun>;
  verifyPr(ws: Workspace, repoKey: string, pr: number): Verification;
  /** What actually changed while the agent ran: anything here is a stop for the owner. */
  audit(ws: Workspace, ticket: Candidate, from: string, to: string): string[];
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
  let finalLabel: string | null = null;
  const log: Logger = (event, detail = {}) => {
    // Every logged value is scrubbed of the secrets in the environment: the log can be public.
    const entry = JSON.parse(redact(JSON.stringify({ t: deps.now().toISOString(), event, ...detail })));
    const shown = Object.keys(detail).length ? ` ${redact(JSON.stringify(detail))}` : "";
    deps.print(`${entry.t} ${event}${shown}`);
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

    const authors = provenanceProblems(deps.snapshot(pick.github, pick.number).provenance, owner);
    if (authors.length) {
      deps.relabel(pick.github, pick.number, [LABELS.ready], []);
      say(
        `Not started. An agent run follows this ticket's text, so only a ticket written, edited and commented on by the repository owner can start one (${authors.join("; ")}). The label has been removed.`,
      );
      log("refused", { reason: authors.join("; ") });
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

    // The agent works from this exact text, taken after the claim, so nothing added later can steer it.
    const snapshot = deps.snapshot(pick.github, pick.number);
    const late = provenanceProblems(snapshot.provenance, owner);
    if (late.length) throw new Error(`the ticket changed before the run started: ${late.join("; ")}`);
    const ticketFile = deps.writeTicket(ws, snapshot.text);
    log("ticket-snapshot", { file: ticketFile, characters: snapshot.text.length });

    const agentFrom = deps.now().toISOString();
    log("agent-started", { command: `/factory ${pick.repoKey} ${pick.number}` });
    const agent = await deps.runAgent(ws, runId, pick.repoKey, pick.number, ticketFile, log);
    const agentTo = deps.now().toISOString();
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
    // Effects, not just commands: the policy hook reads command text, which can't catch everything.
    const audit = [
      ...deps.audit(workspace, pick, agentFrom, agentTo),
      ...ticketChangeProblems(snapshot, deps.snapshot(pick.github, pick.number), owner),
    ];
    log("audited", { from: agentFrom, to: agentTo, problems: audit });
    const settled = settle(
      agent,
      result,
      (pr) => {
        const verification = deps.verifyPr(workspace, pick.repoKey, pr);
        log("verified", { pr, problems: verification.problems });
        return verification;
      },
      pick.github,
      options.minutes,
    );
    const finish: Finish = audit.length
      ? { label: LABELS.help, reason: `the run's audit found: ${audit.join("; ")}`, pr: settled.pr }
      : settled;
    deps.relabel(pick.github, pick.number, [LABELS.working], [finish.label]);
    finalLabel = finish.label;
    const prLine = finish.pr ? `\n\nPull request: ${finish.pr}` : "";
    say(
      finish.label === LABELS.done
        ? `Agent run \`${runId}\` finished: ${finish.reason}.${prLine}`
        : `Agent run \`${runId}\` stopped and needs help: ${finish.reason}.${prLine}`,
    );
    log("finished", { label: finish.label, reason: finish.reason, pr: finish.pr });
    // Logged before the copy is made, so the saved log ends with it too.
    log(finish.label === LABELS.done ? "cleanup" : "kept", { root: ws.root });
    log("saved", { evidence: evidenceFile(factory, runId) });
    deps.saveEvidence(runId, ws);
    if (finish.label === LABELS.done) deps.cleanup(ws);
    return finish.label === LABELS.done ? "done" : "needs-help";
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    log("error", { message, afterLabel: finalLabel });
    // Once the ticket has its final label, a later failure (saving, cleanup) must not add a second one.
    if (claimed && !finalLabel) {
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

type Who = { login?: string } | null;
type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };
type SnapshotComment = {
  author: Who;
  body: string;
  createdAt: string;
  userContentEdits: { totalCount: number; nodes: { editor: Who }[] };
};
/** One GraphQL answer for the issue: its title, body and author, plus the one paged field asked for. */
export type IssuePage = { title: string; body: string | null; author: Who; [field: string]: unknown };
/** Fetches one page of `field` (`userContentEdits` or `comments`) after `cursor`, or the first page. */
export type FetchIssuePage = (field: "userContentEdits" | "comments", cursor: string | null) => IssuePage;

/** Every node of a paged field, following GitHub's cursors until it says there is no next page. */
export function allPages<T>(
  field: "userContentEdits" | "comments",
  fetch: FetchIssuePage,
): { issue: IssuePage; nodes: T[] } {
  const nodes: T[] = [];
  let cursor: string | null = null;
  let issue: IssuePage;
  const seen = new Set<string>();
  do {
    issue = fetch(field, cursor);
    const page = issue[field] as Page<T>;
    nodes.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    // A cursor that doesn't move would loop for ever: treat it as an error, never as the end.
    if (cursor !== null) {
      if (seen.has(cursor)) throw new Error(`GitHub repeated the ${field} cursor ${cursor}`);
      seen.add(cursor);
    }
  } while (cursor !== null);
  return { issue, nodes };
}

/**
 * The ticket's snapshot from GitHub's pages: the text the agent will read, who wrote and edited each
 * part, and its edit history. The history catches an edit that was later undone, which leaves the
 * text and the authors unchanged.
 */
export function buildSnapshot(fetch: FetchIssuePage): TicketSnapshot {
  const login = (who: Who) => who?.login ?? "(deleted user)";
  const edits = allPages<{ editor: Who }>("userContentEdits", fetch);
  const comments = allPages<SnapshotComment>("comments", fetch).nodes;
  const { issue } = edits;
  const text = [
    `# ${issue.title}`,
    "",
    issue.body ?? "",
    ...comments.flatMap((c) => ["", "---", `Comment by ${login(c.author)}, ${c.createdAt}:`, "", c.body]),
  ].join("\n");
  const history = JSON.stringify({
    body: edits.nodes.map((n) => login(n.editor)),
    comments: comments.map((c) => ({ at: c.createdAt, edits: c.userContentEdits.totalCount })),
  });
  return {
    text,
    history,
    provenance: {
      author: login(issue.author),
      editors: edits.nodes.map((n) => login(n.editor)),
      commenters: comments.map((c) => login(c.author)),
      commentEditors: comments.flatMap((c) => c.userContentEdits.nodes.map((n) => login(n.editor))),
      incomplete: comments
        .filter((c) => c.userContentEdits.totalCount > c.userContentEdits.nodes.length)
        .map((c) => `the edits of a comment from ${c.createdAt}`),
    },
  };
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
  // npm is a .cmd file on Windows, which only a shell can start. The arguments are fixed words and
  // numbers from this file, never ticket text, so joining them into one command line is safe.
  const result =
    process.platform === "win32"
      ? spawnSync(["npm", ...args].join(" "), { cwd, encoding: "utf8", shell: true })
      : spawnSync("npm", args, { cwd, encoding: "utf8" });
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

/**
 * `local`: the owner's PC. Worktrees per run, a lock file, and the owner's checkouts are fingerprinted.
 * `ci`: a GitHub Actions run on a fresh VM. The workflow has checked out every repo next to this one, in
 * the same layout; those checkouts are the workspace. The workflow's concurrency group is the lock.
 */
export type RunMode = "local" | "ci";

export function realDeps(factory: FactoryConfig, options: TickOptions, mode: RunMode = "local"): TickDeps {
  const runs = runsDir();
  mkdirSync(runs, { recursive: true });
  const evidenceInPrivate = relative("private", factory.evidence); // e.g. raw-artifacts
  const privateRepo = join(LAB_ROOT, "private");

  /** Worktree folder for a repo: its configured path, resolved from the lab's worktree. */
  const worktreeFor = (labWt: string, path: string) => resolve(labWt, path);

  /** Refuses to start the agent unless both hooks run before every shell command and file edit. */
  const requireHooks = (lab: string) => {
    const settings = join(lab, ".claude", "settings.json");
    const missing = hookProblems(existsSync(settings) ? readFileSync(settings, "utf8") : "");
    if (missing.length) throw new Error(`the workspace's hooks aren't safe to run unattended: ${missing.join("; ")}`);
  };

  const deps: TickDeps = {
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
    snapshot(github, number) {
      const [owner, name] = github.split("/");
      const pageInfo = "pageInfo { hasNextPage endCursor }";
      const parts = {
        userContentEdits: `userContentEdits(first: 100, after: $after) { ${pageInfo} nodes { editor { login } } }`,
        comments: `comments(first: 100, after: $after) { ${pageInfo} nodes { author { login } body createdAt userContentEdits(first: 100) { totalCount nodes { editor { login } } } } }`,
      };
      return buildSnapshot((field, cursor) => {
        const query = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) { issue(number: $number) { title body author { login } ${parts[field]} } } }`;
        const args = ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`];
        args.push("-F", `number=${number}`, ...(cursor ? ["-f", `after=${cursor}`] : []));
        return JSON.parse(gh(...args)).data.repository.issue;
      });
    },
    writeTicket(ws, text) {
      const file = join(ws.root, "ticket.md");
      writeFileSync(file, `${text}\n`);
      return file;
    },
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
      const priv = join(lab, "private");
      const mainAtStart: Record<string, string> = {};
      mkdirSync(root, { recursive: true });
      try {
        for (const [key, repo] of Object.entries(factory.repos)) {
          const source = resolve(LAB_ROOT, repo.path);
          const target = repo.path === "." ? lab : worktreeFor(lab, repo.path);
          git(source, "fetch", "--quiet", "origin", "main");
          mainAtStart[key] = git(source, "rev-parse", "origin/main");
          mkdirSync(dirname(target), { recursive: true });
          git(source, "worktree", "add", "--detach", target, "origin/main");
        }
        git(privateRepo, "fetch", "--quiet", "origin", "main");
        mainAtStart[PRIVATE_KEY] = git(privateRepo, "rev-parse", "origin/main");
        git(privateRepo, "worktree", "add", "-b", `run-${runId}`, priv, "origin/main");
        for (const repo of Object.values(factory.repos)) {
          const dir = repo.path === "." ? lab : worktreeFor(lab, repo.path);
          if (!existsSync(join(dir, "package.json"))) continue;
          const install = npm(dir, "ci", "--no-audit", "--no-fund");
          if (install.status !== 0) throw new Error(`npm ci failed in ${dir}: ${install.output.slice(-400)}`);
        }
        // The agent gets main's hooks, not the runner's: refuse to start it without both of them.
        requireHooks(lab);
      } catch (error) {
        // Undo whatever was set up, so a failed start leaves no worktree or branch behind.
        const leftovers = teardown(root, lab, priv, runId);
        if (leftovers.length)
          throw new Error(`${(error as Error).message}; cleanup also failed: ${leftovers.join("; ")}`);
        throw error;
      }
      return { root, lab, private: priv, mainAtStart, fingerprints: fingerprints(lab) };
    },
    audit(ws, ticket, from, to) {
      const problems: string[] = [];
      for (const [key, repo] of Object.entries(factory.repos)) {
        const now = gh("api", `repos/${repo.github}/commits/main`, "--jq", ".sha").trim();
        const before = ws.mainAtStart[key] ?? "";
        if (now !== before) problems.push(`main of ${key} moved (${before.slice(0, 7)} → ${now.slice(0, 7)})`);
      }
      // The agent may commit evidence to its private branch, but only the runner pushes it, after this audit.
      const privateNow = git(privateRepo, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0] ?? "";
      const privateBefore = ws.mainAtStart[PRIVATE_KEY] ?? "";
      if (privateNow !== privateBefore)
        problems.push(`main of the private repo moved (${privateBefore.slice(0, 7)} → ${privateNow.slice(0, 7)})`);
      const after = fingerprints(ws.lab);
      for (const [what, value] of Object.entries(ws.fingerprints)) {
        if (after[what] !== value) problems.push(`${what} changed during the run`);
      }
      type Comment = { user?: { login: string }; created_at: string; html_url: string };
      const comments = Object.values(factory.repos).flatMap((repo) =>
        ["issues/comments", "pulls/comments"].flatMap((kind) =>
          (
            JSON.parse(
              gh("api", "--paginate", "--slurp", `repos/${repo.github}/${kind}?since=${from}&per_page=100`),
            ) as Comment[][]
          )
            .flat()
            .map((c) => ({ user: c.user?.login ?? "", created_at: c.created_at, url: c.html_url })),
        ),
      );
      const ticketEvents = (
        JSON.parse(
          gh("api", "--paginate", "--slurp", `repos/${ticket.github}/issues/${ticket.number}/events?per_page=100`),
        ) as IssueEvent[][]
      ).flat();
      // Submitted reviews (approve, request changes) leave no comment: read them from every PR touched since.
      type Pull = { number: number; updated_at: string };
      type Review = { user?: { login: string }; submitted_at?: string; html_url: string };
      const reviews = Object.values(factory.repos).flatMap((repo) =>
        (
          JSON.parse(
            gh("api", `repos/${repo.github}/pulls?state=all&sort=updated&direction=desc&per_page=50`),
          ) as Pull[]
        )
          .filter((pull) => Date.parse(pull.updated_at) >= Math.floor(Date.parse(from) / 1000) * 1000)
          .flatMap((pull) =>
            (
              JSON.parse(
                gh("api", "--paginate", "--slurp", `repos/${repo.github}/pulls/${pull.number}/reviews?per_page=100`),
              ) as Review[][]
            ).flat(),
          )
          .filter((r) => r.submitted_at)
          .map((r) => ({ user: r.user?.login ?? "", created_at: r.submitted_at ?? "", url: r.html_url })),
      );
      const owner = ticket.github.split("/")[0] ?? "";
      return [...problems, ...windowProblems({ comments, ticketEvents, reviews }, owner, from, to)];
    },
    runAgent(ws, runId, repoKey, number, ticketFile, log) {
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
        agentInstructions(ws.root, repoKey, number, ticketFile),
        ...extraDirs,
      ];
      return new Promise((done) => {
        const child = spawn(claudeBinary(), args, {
          cwd: ws.lab,
          env: {
            ...process.env,
            FAULTFORGE_FACTORY_RUN: runId,
            FAULTFORGE_RUN_ROOT: ws.root,
            FAULTFORGE_TICKET_NUMBER: String(number),
          },
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
                log("agent-step", { step, command: command.slice(0, 120) });
              }
            } else if (part.type === "tool_result" && commands.has(part.tool_use_id ?? "")) {
              // No output here: the event log can be public (an Actions log or artifact). The full
              // output stays in the agent transcript, which only goes to the private repo.
              log("agent-step-result", { step: commands.get(part.tool_use_id ?? ""), error: Boolean(part.is_error) });
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
        let settled = false;
        // A binary that can't start emits "error" and maybe never "close": report it, don't hang or crash.
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          done({
            exitCode: null,
            timedOut: false,
            resultText: null,
            subtype: `could not start the agent: ${error.message}`,
            costUsd: null,
            turns: null,
          });
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
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
      if (review.status !== 0) {
        problems.push(meaning[review.status ?? 2] ?? `review:wait exited ${review.status}`);
        return { problems };
      }
      // A complete review can still have findings open: only none action-required counts as ready.
      const record = join(
        ws.lab,
        factory.evidence,
        "reviews",
        `${repoKey}-pr${pr}`,
        `${String(view.headRefOid).slice(0, 7)}.review.json`,
      );
      if (!existsSync(record)) problems.push("review:wait saved no review record for the head commit");
      else {
        const open = openActionRequired(JSON.parse(readFileSync(record, "utf8")));
        if (open.length) problems.push(`${open.length} action-required finding(s) still open: ${open.join("; ")}`);
      }
      return { problems };
    },
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
      const leftovers = teardown(ws.root, ws.lab, ws.private, basename(ws.root));
      if (leftovers.length) throw new Error(`cleanup failed: ${leftovers.join("; ")}`);
    },
  };
  if (mode === "local") return deps;

  return {
    ...deps,
    // The workflow's concurrency group allows one run at a time.
    lock: () => ({ acquired: true, release: () => {} }),
    workspace() {
      const mainAtStart: Record<string, string> = {};
      for (const [key, repo] of Object.entries(factory.repos)) {
        const dir = resolve(LAB_ROOT, repo.path);
        git(dir, "fetch", "--quiet", "origin", "main");
        const head = git(dir, "rev-parse", "HEAD");
        const main = git(dir, "rev-parse", "origin/main");
        if (head !== main)
          throw new Error(`the ${key} checkout is at ${head.slice(0, 7)}, not origin/main ${main.slice(0, 7)}`);
        if (!existsSync(join(dir, "node_modules")) && existsSync(join(dir, "package.json")))
          throw new Error(`the ${key} checkout has no node_modules: the workflow must run npm ci first`);
        mainAtStart[key] = main;
      }
      git(privateRepo, "fetch", "--quiet", "origin", "main");
      mainAtStart[PRIVATE_KEY] = git(privateRepo, "rev-parse", "origin/main");
      requireHooks(LAB_ROOT);
      return {
        root: dirname(LAB_ROOT),
        lab: LAB_ROOT,
        private: privateRepo,
        mainAtStart,
        fingerprints: fingerprints(LAB_ROOT),
      };
    },
    // The VM is thrown away after the run.
    cleanup: () => {},
  };

  /**
   * Removes a run's worktrees, its private branch and its folder, as far as they exist. Each step is
   * tried on its own; returns what couldn't be removed. The private worktree sits inside the lab's
   * worktree, so it goes first, through its own repo.
   */
  function teardown(root: string, lab: string, priv: string, runId: string): string[] {
    const failed: string[] = [];
    const attempt = (what: string, step: () => void) => {
      try {
        step();
      } catch (error) {
        failed.push(`${what}: ${(error as Error).message.split("\n")[0]}`);
      }
    };
    const registered = (repo: string, path: string) =>
      git(repo, "worktree", "list", "--porcelain")
        .split("\n")
        .some((line) => line.startsWith("worktree ") && resolve(line.slice(9)) === resolve(path));
    if (registered(privateRepo, priv))
      attempt("private worktree", () => git(privateRepo, "worktree", "remove", "--force", priv));
    if (git(privateRepo, "branch", "--list", `run-${runId}`))
      attempt("private branch", () => git(privateRepo, "branch", "-D", `run-${runId}`));
    for (const repo of Object.values(factory.repos)) {
      const source = resolve(LAB_ROOT, repo.path);
      const path = repo.path === "." ? lab : worktreeFor(lab, repo.path);
      if (repo.path !== "." && registered(source, path))
        attempt(`${basename(path)} worktree`, () => git(source, "worktree", "remove", "--force", path));
    }
    if (registered(LAB_ROOT, lab)) attempt("lab worktree", () => git(LAB_ROOT, "worktree", "remove", "--force", lab));
    attempt("run folder", () => rmSync(root, { recursive: true, force: true }));
    return failed;
  }

  /**
   * Fingerprints of what the agent must not change: the owner's own checkouts (commit, branch and
   * uncommitted changes) and the guardrail files in the run's lab worktree.
   */
  function fingerprints(lab: string): Record<string, string> {
    const prints: Record<string, string> = {};
    // In CI the checkouts are the agent's own workspace, and no owner checkout exists to protect.
    const checkouts =
      mode === "ci"
        ? []
        : [LAB_ROOT, privateRepo, ...Object.values(factory.repos).map((r) => resolve(LAB_ROOT, r.path))];
    for (const dir of new Set(checkouts)) {
      prints[`the owner's checkout ${dir}`] = hash(
        `${git(dir, "rev-parse", "HEAD")}\n${git(dir, "branch", "--show-current")}\n${git(dir, "status", "--porcelain")}`,
      );
    }
    // Every file under .claude: settings, hooks and the skills the agent follows.
    const guardrails = join(lab, ".claude");
    const files = (readdirSync(guardrails, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
      .filter((entry) => entry.isFile())
      .map((entry) => relative(guardrails, join(entry.parentPath, entry.name)).replace(/\\/g, "/"))
      .sort();
    prints[`the run's guardrail files (${guardrails})`] = hash(
      files.map((f) => `${f}\n${readFileSync(join(guardrails, f), "utf8")}`).join("\n"),
    );
    return prints;
  }
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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
    console.error(
      `usage: npm run factory:tick -- [--ci] [--minutes N] [--budget USD]   (${name} must be a positive number)`,
    );
    process.exit(2);
  }
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const options = { minutes: option(args, "--minutes", 120), budget: option(args, "--budget", 25) };
  const mode: RunMode = args.includes("--ci") ? "ci" : "local";
  if (!process.env.GH_TOKEN && process.env.GH_TOKEN_FILE)
    process.env.GH_TOKEN = readFileSync(process.env.GH_TOKEN_FILE, "utf8").trim();
  if (!process.env.GH_TOKEN) {
    console.error("factory:tick needs GH_TOKEN or GH_TOKEN_FILE.");
    process.exit(2);
  }
  const factory = loadFactory();
  const outcome = await tick(factory, realDeps(factory, options, mode), options);
  process.exit(outcome === "needs-help" ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();

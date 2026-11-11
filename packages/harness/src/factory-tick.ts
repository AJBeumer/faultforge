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
 *  5. Check Qodo's configuration against the snapshot (`qodo:check`). A difference or a failed check
 *     (`qodo-check.ts`) ends the run `agent-needs-help` here, before a workspace is ever built.
 *  6. Fresh worktrees of every repo from `origin/main`, and of the private repo on its own branch,
 *     laid out like the owner's folders, so the owner's working trees are never touched.
 *  7. Run `claude -p "/factory <repo> <N>"` there, with a dollar budget, a time limit, deny rules, and
 *     the factory policy hook switched on.
 *  8. Don't take the agent's word: check the PR is open in the ticket's repo, its checks passed, Qodo's
 *     review of its head commit is complete, and `main` didn't move during the run.
 *  9. Label the ticket `agent-done` or `agent-needs-help`, comment why, push the run log to the private
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
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type FactoryConfig, loadFactory, repoConfig } from "./factory-config.ts";
import { telltales } from "./neutral.ts";
import { checkLiveQodoConfig, type Difference, formatDifference, summarizeDifference } from "./qodo-check.ts";
import { proposeAfterRun } from "./rules-propose.ts";
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
 * True when a git-reported path is `prefix` itself or inside it. Never trims or otherwise normalises
 * `path`: a leading or trailing space is part of the real filename git is naming, not formatting noise,
 * and treating ` raw-artifacts/x` as `raw-artifacts/x` would let a root-level path with a stray space
 * pass as if it were under the evidence root when the file it names is not (Qodo on PR 141).
 */
function underEvidencePrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Of `paths` (as git reports them, forward-slash, unmodified), the ones that fall outside both allowed
 * evidence roots: the configured evidence root (e.g. `raw-artifacts`) and `factory-log`. Only these ever
 * stop a push to the private repo's `main` (#102): the answer key and audit log must stay append-only,
 * and the factory must never be the one to rewrite them. Only drops lines that are genuinely blank (the
 * trailing empty entry `split("\n")` leaves after the last newline), never a path's own whitespace.
 */
export function blockedEvidencePaths(paths: string[], evidenceRoot: string): string[] {
  return paths.filter(
    (p) => p !== "" && !underEvidencePrefix(p, evidenceRoot) && !underEvidencePrefix(p, "factory-log"),
  );
}

/**
 * Every path that differs between `priv`'s worktree (as it stands right now, committed or not) and
 * `origin/main`: committed changes made earlier in the run, plus whatever is modified or untracked in
 * the working tree. Every one of the three commands below prints a bare path per line, nothing else —
 * deliberately never `git status --porcelain`, whose leading status characters can be mistaken for part
 * of the path once the shared `git`/`gitLong` helpers (used here, same as everywhere else) have trimmed
 * the overall output: a path that starts with its own letter can then read as if a status prefix were
 * still attached to it, or the reverse (Qodo on PR 141, round 2). `--no-renames` forces a rename apart
 * into its old and new paths, so a protected file moved under the evidence root still shows its old,
 * now-missing path — `--name-only` alone would report only the allowed destination and hide that the
 * source was removed from `main`.
 */
function changedAgainst(priv: string, run: (cwd: string, ...args: string[]) => string, origin: string): string[] {
  const lines = (s: string) => s.split("\n").filter((p) => p !== "");
  const committed = lines(run(priv, "diff", "--no-renames", "--name-only", origin, "HEAD"));
  const uncommitted = lines(run(priv, "diff", "--no-renames", "--name-only", "HEAD"));
  const untracked = lines(run(priv, "ls-files", "--others", "--exclude-standard"));
  return [...new Set([...committed, ...uncommitted, ...untracked])];
}

export interface EvidencePush {
  /** True once the private branch's commits reached `main`. */
  pushed: boolean;
  /** Changed paths outside the allowed evidence roots; empty when the push went through. */
  blocked: string[];
  /** Where a blocked run's commits were kept instead (a branch name), if that push itself succeeded. */
  savedAt?: string;
}

/** How many times a blocked run's quarantine push is retried before giving up on it (Qodo on PR 141: a
 *  single attempt loses the evidence to a transient failure as surely as to a real one). */
const QUARANTINE_PUSH_ATTEMPTS = 3;

/**
 * Lists every path `priv`'s branch changed against `origin/main`, before anything is staged or committed
 * (#102), and decides from that list alone whether the branch may reach `main`: every path must be under
 * one of the allowed evidence roots, or nothing does. Only once that's decided does it commit what's
 * there, and push it either to `main` (allowed) or to a branch of its own (blocked, so the owner still has
 * somewhere to read it, retried a few times against a transient failure); `main` never moves when blocked.
 */
export function commitAndPublish(
  priv: string,
  evidenceRoot: string,
  runId: string,
  run: (cwd: string, ...args: string[]) => string,
  runLong: (cwd: string, ...args: string[]) => string,
): EvidencePush {
  runLong(priv, "fetch", "--quiet", "origin", "main");
  const blocked = blockedEvidencePaths(changedAgainst(priv, run, "origin/main"), evidenceRoot);
  run(priv, "add", "-A");
  if (run(priv, "status", "--porcelain"))
    run(priv, "commit", "--quiet", "-m", `Factory run ${runId}: log and evidence`);
  run(priv, "rebase", "--quiet", "origin/main");
  if (blocked.length) {
    const branch = `blocked-${runId}`;
    let savedAt: string | undefined;
    for (let attempt = 0; attempt < QUARANTINE_PUSH_ATTEMPTS && !savedAt; attempt++) {
      try {
        runLong(priv, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
        savedAt = branch;
      } catch {
        // Retried, up to the attempt limit; left undefined, the kept worktree/run folder is the
        // last-resort copy, and that one is not durable once a CI run's own VM is discarded (#102,
        // disclosed in the PR: durable delivery through that case needs a workflow-level fix, out of
        // scope for an unattended run that may not touch .github/workflows).
      }
    }
    return { pushed: false, blocked, savedAt };
  }
  runLong(priv, "push", "--quiet", "origin", "HEAD:main");
  return { pushed: true, blocked: [] };
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
  if (agent.timedOut)
    return { label: LABELS.help, reason: `hit the time limit of ${minutes} minutes`, pr: agent.lastPr ?? null };
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
/**
 * The commit the runner must see reviewed: the agent's own branch tip in its worktree. GitHub's PR view
 * can still show the previous head right after a push (PR 65), so it is used only when the branch isn't
 * in the worktree. Null when neither is a commit id: the result goes on an npm command line.
 */
export function commitToVerify(localTip: string | null, viewHead: string): string | null {
  const commit = localTip ?? viewHead;
  return /^[0-9a-f]{40}$/i.test(commit) ? commit : null;
}

/** Problems with the PR as GitHub shows it once the review of `pushed` is complete. */
export function prViewProblems(
  view: { state: string; headRefOid: string; statusCheckRollup?: Parameters<typeof checkProblems>[0] },
  pushed: string,
): string[] {
  const problems: string[] = [];
  if (view.state !== "OPEN") problems.push(`the pull request is ${String(view.state).toLowerCase()}, not open`);
  if (view.headRefOid !== pushed) {
    problems.push(
      `GitHub shows the head as ${view.headRefOid.slice(0, 7)}, not the agent's last commit ${pushed.slice(0, 7)}`,
    );
  }
  problems.push(...checkProblems(view.statusCheckRollup ?? []));
  return problems;
}

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

/**
 * The shortest time limit (seconds) the settings give either hook. Claude Code's default is 60. A hook
 * that exceeds its limit is a non-blocking error, so the self-test below also checks speed.
 */
export function hookTimeoutSeconds(settingsText: string): number {
  let hooks: { hooks?: { command?: string; timeout?: number }[] }[] = [];
  try {
    hooks = JSON.parse(settingsText).hooks?.PreToolUse ?? [];
  } catch {
    return 60;
  }
  const limits = hooks
    .flatMap((h) => h.hooks ?? [])
    .filter((c) => ["guard-target.ts", "factory-policy.ts"].some((f) => runsHook(c.command ?? "", f)))
    .map((c) => (typeof c.timeout === "number" && c.timeout > 0 ? c.timeout : 60));
  return limits.length ? Math.min(...limits) : 60;
}

/** One answer from a hook run with a payload: what it printed, how it exited, and how long it took. */
export interface HookAnswer {
  stdout: string;
  status: number | null;
  ms: number;
}

/** Runs one hook file with stdin text and extra environment, as Claude Code would. */
export type HookRunner = (hook: string, stdin: string, env: Record<string, string>) => HookAnswer;

/**
 * What Claude Code would make of a hook's answer. Exit 2 is a blocking error (the tool call is refused);
 * exit 0 with no output allows; exit 0 with a well-formed PreToolUse decision is that decision. Anything
 * else is invalid: Claude Code ignores it and lets the tool run, so a deny printed without
 * `hookEventName` is not a deny (Qodo on PR 115).
 */
export function hookDecision(answer: HookAnswer): "deny" | "allow" | "ask" | "silent" | "invalid" {
  if (answer.status === 2) return "deny";
  if (answer.status !== 0) return "invalid";
  if (!answer.stdout.trim()) return "silent";
  try {
    const out = JSON.parse(answer.stdout).hookSpecificOutput;
    if (out?.hookEventName !== "PreToolUse") return "invalid";
    return ["deny", "allow", "ask"].includes(out.permissionDecision) ? out.permissionDecision : "invalid";
  } catch {
    return "invalid";
  }
}

/**
 * Proves both hooks work before an agent runs: each must deny what it exists to deny, allow a harmless
 * command, and deny when its input is not JSON (a crash would otherwise let the tool run). Each answer
 * must come well inside the time limit, since a hook that times out is also a bypass. `reviewedFolder`
 * is a reviewed repo's checkout, where the guard must block a telltale commit message. Returns the
 * problems found, or an empty list.
 */
export function hookSelfTest(lab: string, reviewedFolder: string, limitSeconds: number, run: HookRunner): string[] {
  const payload = (tool: string, input: object, cwd: string) =>
    JSON.stringify({ tool_name: tool, cwd, tool_input: input });
  const runEnv = { FAULTFORGE_FACTORY_RUN: "self-test", FAULTFORGE_RUN_ROOT: lab };
  const cases: { hook: string; name: string; stdin: string; env: Record<string, string>; expectDeny: boolean }[] = [
    {
      hook: "guard-target.ts",
      name: "a telltale commit in a reviewed repo",
      stdin: payload("Bash", { command: 'git commit -m "Fix the planted bug"' }, reviewedFolder),
      env: {},
      expectDeny: true,
    },
    {
      hook: "guard-target.ts",
      name: "a harmless command",
      stdin: payload("Bash", { command: "npm run check" }, lab),
      env: {},
      expectDeny: false,
    },
    { hook: "guard-target.ts", name: "input that is not JSON", stdin: "not json", env: {}, expectDeny: true },
    {
      hook: "factory-policy.ts",
      name: "a merge inside a run",
      stdin: payload("Bash", { command: "gh pr merge 1 --squash" }, lab),
      env: runEnv,
      expectDeny: true,
    },
    {
      hook: "factory-policy.ts",
      name: "a harmless command inside a run",
      stdin: payload("Bash", { command: "npm run check" }, lab),
      env: runEnv,
      expectDeny: false,
    },
    { hook: "factory-policy.ts", name: "input that is not JSON", stdin: "not json", env: runEnv, expectDeny: true },
  ];
  const problems: string[] = [];
  const budgetMs = (limitSeconds * 1000) / 2;
  for (const c of cases) {
    const answer = run(c.hook, c.stdin, c.env);
    const decision = hookDecision(answer);
    const detail = `decision ${decision}, exit ${answer.status}, output ${JSON.stringify(answer.stdout.trim().slice(0, 80))}`;
    if (c.expectDeny && decision !== "deny") problems.push(`${c.hook} let through ${c.name} (${detail})`);
    // A harmless command must pass without a question: in an unattended run nobody answers an "ask".
    if (!c.expectDeny && decision !== "silent" && decision !== "allow")
      problems.push(`${c.hook} refused ${c.name} (${detail})`);
    if (answer.ms > budgetMs)
      problems.push(
        `${c.hook} took ${answer.ms} ms on ${c.name}; it must answer within half its ${limitSeconds} s limit`,
      );
  }
  return problems;
}

/** Runs a hook file from the workspace's `.claude/hooks` with node, the way settings.json does. */
export function realHookRunner(lab: string, limitSeconds: number): HookRunner {
  return (hook, stdin, env) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [join(lab, ".claude", "hooks", hook)], {
      input: stdin,
      encoding: "utf8",
      env: {
        ...process.env,
        FAULTFORGE_FACTORY_RUN: "",
        FAULTFORGE_RUN_ROOT: "",
        FAULTFORGE_TICKET_NUMBER: "",
        ...env,
      },
      timeout: limitSeconds * 1000,
    });
    return { stdout: result.stdout ?? "", status: result.status, ms: Date.now() - started };
  };
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

/** What `qodo:check` found: `exitCode` 0 means it matches the snapshot, 1 a difference was found (each
 * one in `differences`), 2 it couldn't be checked at all (no key, no snapshot, an API or parse error).
 * Kept structured, not pre-formatted: a difference's full detail (a rule's `content`, its field values)
 * is fine for the run log, but never for a ticket comment (Qodo on PR 145) - callers pick the
 * formatter that matches where the text is going. */
export interface QodoCheckOutcome {
  exitCode: 0 | 1 | 2;
  message: string;
  differences: Difference[];
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
  relabel(github: string, number: number, remove: string[], add: string[]): RelabelProblems;
  comment(github: string, number: number, body: string): void;
  /** Compares Qodo's live configuration with the snapshot, before the workspace (and its hook self-test)
   * is built: a drift in the reviewer is caught before an agent is ever started on it. */
  qodoCheck(runId: string): Promise<QodoCheckOutcome>;
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
  /** Saves the run log (and the agent's transcript) to the private repo, and publishes what's allowed. */
  saveEvidence(runId: string, ws: Workspace | null): EvidencePush & { file: string };
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
    // relabel still adds the new label even when removing the old one failed (real side effects, below).
    // A failed removal is just logged - an old label left lingering is cosmetic - but a failed add means
    // the ticket's intended new state was never recorded, so this throws for the caller to treat as any
    // other failure here: never silently proceeding as if the ticket now shows what it doesn't.
    const relabel = (remove: string[], add: string[]) => {
      const { removeFailed, addFailed } = deps.relabel(pick.github, pick.number, remove, add);
      if (removeFailed) {
        log("error", {
          message: `couldn't remove a label from the ticket: ${removeFailed instanceof Error ? removeFailed.message : removeFailed}`,
        });
      }
      if (addFailed) throw addFailed instanceof Error ? addFailed : new Error(String(addFailed));
    };
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
      relabel([LABELS.ready], []);
      say(
        `Not started. The \`${LABELS.ready}\` label was added by ${pick.labelledBy}, and only the repository owner can start an agent run. The label has been removed.`,
      );
      log("refused", { reason: `label added by ${pick.labelledBy}, not the owner ${owner}` });
      deps.saveEvidence(runId, null);
      return "refused";
    }

    const authors = provenanceProblems(deps.snapshot(pick.github, pick.number).provenance, owner);
    if (authors.length) {
      relabel([LABELS.ready], []);
      say(
        `Not started. An agent run follows this ticket's text, so only a ticket written, edited and commented on by the repository owner can start one (${authors.join("; ")}). The label has been removed.`,
      );
      log("refused", { reason: authors.join("; ") });
      deps.saveEvidence(runId, null);
      return "refused";
    }

    const readiness = deps.ready(pick.repoKey, pick.number);
    if (readiness.problems.length) {
      relabel([LABELS.ready], [LABELS.help]);
      say(
        `Not started: this ticket isn't ready yet.\n\n${readiness.problems.map((p) => `- ${p}`).join("\n")}\n\nFix the ticket and add \`${LABELS.ready}\` again.`,
      );
      log("not-ready", { problems: readiness.problems });
      deps.saveEvidence(runId, null);
      return "not-ready";
    }

    claimed = pick;
    relabel([LABELS.ready], [LABELS.working]);
    say(
      `Picked up by scheduled agent run \`${runId}\`. Limits: ${options.minutes} minutes, three review rounds. It will report here when it stops; merging stays with the owner.`,
    );
    log("claimed", { limits: { minutes: options.minutes, budgetUsd: options.budget, reviewRounds: 3 } });

    const qodo = await deps.qodoCheck(runId);
    log("qodo-checked", {
      exitCode: qodo.exitCode,
      message: qodo.message,
      differences: qodo.differences.map(formatDifference),
    });
    if (qodo.exitCode !== 0) {
      relabel([LABELS.working, LABELS.ready], [LABELS.help]);
      finalLabel = LABELS.help;
      const reason =
        qodo.exitCode === 2
          ? `Qodo's configuration couldn't be checked against the snapshot (${qodo.message})`
          : `Qodo's configuration has drifted from the snapshot (${qodo.message})`;
      // A summary only: the full detail (a rule's content, a field's before/after) can hold text read
      // from private storage, which must never reach a ticket a reviewer can read (Qodo on PR 145).
      const summary = qodo.differences.map(summarizeDifference);
      say(
        `Agent run \`${runId}\` stopped and needs help: ${reason}${summary.length ? `\n\n${summary.map((l) => `- ${l}`).join("\n")}` : ""}.`,
      );
      log("finished", { label: LABELS.help, reason, pr: null });
      log("saved", { evidence: evidenceFile(factory, runId) });
      deps.saveEvidence(runId, null);
      return "needs-help";
    }

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
    // ready-for-agent is stripped again here too: if its removal at the claim failed silently (logged,
    // not fatal, above), a ticket that already finished must never still look pickable by a later tick.
    relabel([LABELS.working, LABELS.ready], [finish.label]);
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
    const saved = deps.saveEvidence(runId, ws);
    if (saved.blocked.length) {
      log("evidence-blocked", { blocked: saved.blocked, savedAt: saved.savedAt ?? null });
      const where = saved.savedAt
        ? `the private repository's \`${saved.savedAt}\` branch`
        : `the run folder (\`${ws.root}\`), kept for inspection`;
      // Sanitised on its own, so a protected word among the blocked paths only blanks this clause, never
      // the branch or folder the owner needs to find the evidence by (Qodo on PR 141).
      const paths = safeText(saved.blocked.join(", "), reviewed);
      const blockedMessage = `The run also changed files in the private repository outside \`raw-artifacts/\` and \`factory-log/\` (${paths}). Nothing was pushed to its \`main\`; the run log and transcript are saved instead in ${where}.`;
      // Said before the relabel, and each retried once on its own: one failing must never also cost the
      // other, and the run log (which the run-log copy itself always reaches, win or lose) is never the
      // owner's only way to learn a done-looking ticket was actually blocked (Qodo on PR 141, round 2).
      const once = (what: string, fn: () => void): boolean => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            fn();
            return true;
          } catch (error) {
            log("error", { message: `couldn't ${what}: ${error instanceof Error ? error.message : error}` });
          }
        }
        return false;
      };
      once("comment the blocked evidence on the ticket", () => say(blockedMessage));
      if (finish.label !== LABELS.help) {
        if (
          once(`relabel the blocked run to ${LABELS.help}`, () =>
            relabel([LABELS.working, LABELS.ready, finish.label], [LABELS.help]),
          )
        ) {
          finalLabel = LABELS.help;
        }
      }
      // The run folder is only kept when even the blocked-branch push failed: that's the one case
      // left where it's the owner's sole copy (Qodo on PR 141).
      if (saved.savedAt) deps.cleanup(ws);
      return "needs-help";
    }
    if (finish.label === LABELS.done) deps.cleanup(ws);
    return finish.label === LABELS.done ? "done" : "needs-help";
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    log("error", { message, afterLabel: finalLabel });
    // Once the ticket has its final label, a later failure (saving, cleanup) must not add a second one.
    // The relabel and the comment are tried independently: one failing must never also swallow the other,
    // or the ticket is left agent-working with nothing alive to say why.
    if (claimed && !finalLabel) {
      // ready-for-agent too: the claim may have left it in place (logged there, not fatal), and this is
      // the last chance to strip it before a later tick could otherwise pick the same ticket up again.
      const { removeFailed, addFailed } = deps.relabel(
        claimed.github,
        claimed.number,
        [LABELS.working, LABELS.ready],
        [LABELS.help],
      );
      if (removeFailed) {
        log("error", {
          message: `couldn't remove a label from the ticket: ${removeFailed instanceof Error ? removeFailed.message : removeFailed}`,
        });
      }
      if (addFailed) {
        log("error", {
          message: `couldn't update the ticket's label: ${addFailed instanceof Error ? addFailed.message : addFailed}`,
        });
      }
      try {
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
        const saved = deps.saveEvidence(runId, ws);
        if (saved.blocked.length) log("evidence-blocked", { blocked: saved.blocked, savedAt: saved.savedAt ?? null });
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

/** The time limit for an ordinary `gh` or `git` call. A push or a fetch/clone gets `LONG_CALL_TIMEOUT_MS`
 * instead: a slow network can make either legitimately take longer than everything else the tick runs. */
export const CALL_TIMEOUT_MS = 60_000;
export const LONG_CALL_TIMEOUT_MS = 10 * 60_000;

/** True when a `child_process` error is Node reporting that the call exceeded its `timeout` option. */
export function isTimeoutError(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
}

/**
 * A failed `gh` or `git` call, with the call named so a stop the run reports (the audit, the verify
 * step, a relabel) says which one hung or failed, never just "the runner failed".
 */
export class ExternalCallError extends Error {
  readonly timedOut: boolean;
  readonly stderr: string;
  constructor(label: string, cause: unknown) {
    const timedOut = isTimeoutError(cause);
    const stderr =
      cause && typeof cause === "object" && "stderr" in cause
        ? String((cause as { stderr?: unknown }).stderr ?? "")
        : "";
    const detail = stderr.trim().split("\n").at(-1) || (cause instanceof Error ? cause.message : String(cause));
    super(timedOut ? `${label} timed out` : `${label} failed: ${detail}`);
    this.name = "ExternalCallError";
    this.timedOut = timedOut;
    this.stderr = stderr;
  }
}

/**
 * True only when a failed label removal is GitHub saying the label wasn't on the issue to begin with
 * (its own HTTP 404 message, not a timeout or any other failure). Anything else - no permission, the
 * issue or repo gone, a hung call - must be reported, never swallowed as "already gone".
 */
export function isLabelAlreadyGone(error: unknown): boolean {
  if (!(error instanceof ExternalCallError) || error.timedOut) return false;
  return /HTTP 404/.test(error.stderr) && /label does not exist/i.test(error.stderr);
}

/** What went wrong removing or adding a ticket's labels, or null for either that didn't. A failed removal
 * just leaves an old label lingering - cosmetic, safe to log and move on from. A failed add means the
 * ticket's new state was never recorded at all, which the caller must never treat as if it had been. */
export interface RelabelProblems {
  removeFailed: unknown;
  addFailed: unknown;
}

/**
 * Removes each label with `removeOne`, then adds `add` with `addAll` - always, even when a removal
 * failed. Never throws: both failures (a removal other than `isLabelAlreadyGone`, or the add itself) are
 * returned, so the caller can treat them differently rather than one masking the other.
 */
export function relabelWith(
  remove: string[],
  add: string[],
  removeOne: (label: string) => void,
  addAll: (labels: string[]) => void,
): RelabelProblems {
  let removeFailed: unknown = null;
  for (const label of remove) {
    try {
      removeOne(label);
    } catch (error) {
      if (!isLabelAlreadyGone(error)) removeFailed ??= error;
    }
  }
  let addFailed: unknown = null;
  if (add.length) {
    try {
      addAll(add);
    } catch (error) {
      addFailed = error;
    }
  }
  return { removeFailed, addFailed };
}

// ---------------------------------------------------------------------------------------------
// Real side effects

function runsDir(): string {
  return resolve(process.env.FAULTFORGE_RUNS_DIR ?? join(LAB_ROOT, "..", "faultforge-runs"));
}

/** Runs an external command with a time limit, throwing a `ExternalCallError` named after it on failure. */
export function runExternal(
  label: string,
  bin: string,
  args: string[],
  timeoutMs: number,
  extra: { maxBuffer?: number; stdio?: ["ignore", "pipe", "pipe"] } = {},
): string {
  try {
    return execFileSync(bin, args, { encoding: "utf8", timeout: timeoutMs, ...extra }) as unknown as string;
  } catch (error) {
    throw new ExternalCallError(label, error);
  }
}

function gh(...args: string[]): string {
  return runExternal(`gh ${args[0] ?? ""}`.trim(), "gh", args, CALL_TIMEOUT_MS, { maxBuffer: 64 * 1024 * 1024 });
}

function git(cwd: string, ...args: string[]): string {
  return runExternal(`git ${args[0] ?? ""}`.trim(), "git", ["-C", cwd, ...args], CALL_TIMEOUT_MS, {
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** For a push, or a fetch/clone: the same as `git`, but with the longer time limit. */
function gitLong(cwd: string, ...args: string[]): string {
  return runExternal(`git ${args[0] ?? ""}`.trim(), "git", ["-C", cwd, ...args], LONG_CALL_TIMEOUT_MS, {
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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

/**
 * The tick's lock file in `dir`. Taking it fresh is a single atomic `wx` write, so two ticks racing for
 * an unheld lock can never both get it.
 *
 * Taking over a *stale* one (its pid is dead) is not naturally atomic - removing the old file and writing
 * the new one are two steps - so it goes through `renameSync` instead of `rmSync`: moving a file away is
 * exclusive on its *source* path the same way `wx` is exclusive on a path that doesn't exist yet. Two
 * ticks can both try to move the same stale lock out of the way, but only one `renameSync` call can ever
 * succeed against that source path - the other's throws ENOENT, because by then there is nothing left
 * there to rename, and it reports losing the race, same as for a live holder.
 *
 * Reading the stale lock's own content and deciding it is stale are still two steps, so between them
 * another tick can have already moved it out of the way and taken a fresh lock of its own: this tick's
 * rename would then isolate that fresh lock by accident, not the stale one it read. The rename's result is
 * checked against exactly the bytes read before deciding to act, and restored if they no longer match,
 * rather than ever proceeding on a lock that turned out to belong to someone else. Only once that check
 * passes does the winner take the now-empty path for itself; if a third tick's own plain, unrelated `wx`
 * write lands in the instant between that and its own `take()`, that `take()` fails too, and it reports
 * losing that race as well.
 */
export function acquireLock(
  dir: string,
  isAlive: (pid: number) => boolean = pidAlive,
): { acquired: boolean; release(): void; note?: string } {
  const file = join(dir, "factory.lock");
  const take = () =>
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
  const release = () => rmSync(file, { force: true });
  try {
    take();
    return { acquired: true, release };
  } catch {
    // Fallen through: something is already at `file`, live or stale.
  }
  let heldText = "";
  let held: { pid?: number; at?: string } = {};
  try {
    heldText = readFileSync(file, "utf8");
    held = JSON.parse(heldText);
  } catch {
    // An unreadable lock is treated as stale below; heldText stays "" and won't match anything real.
  }
  if (held.pid && isAlive(held.pid))
    return { acquired: false, release: () => {}, note: `pid ${held.pid} since ${held.at}` };
  const graveyard = join(dir, `factory.lock.stale.${process.pid}.${Math.random().toString(36).slice(2)}`);
  try {
    renameSync(file, graveyard);
  } catch {
    return { acquired: false, release: () => {}, note: "lost the race to take over a stale lock" };
  }
  // The rename atomically isolated whatever was actually at `file`: check it is still the exact stale
  // lock just read, not another tick's fresh one that replaced it in the instant between that read and
  // this rename. A mismatch means this tick just took someone else's live lock by accident; put it back
  // and report losing the race, rather than ever proceeding on a lock that belongs to someone else.
  let isolatedText: string | null = null;
  try {
    isolatedText = readFileSync(graveyard, "utf8");
  } catch {
    // Nothing else ever names this exact graveyard path; vanishing here would be stranger still.
  }
  if (isolatedText !== heldText) {
    try {
      renameSync(graveyard, file);
    } catch {
      // Already gone or replaced again since: nothing more to undo.
    }
    return { acquired: false, release: () => {}, note: "lost the race to take over a stale lock" };
  }
  rmSync(graveyard, { force: true });
  try {
    take();
  } catch {
    return { acquired: false, release: () => {}, note: "lost the race to take over a stale lock" };
  }
  return {
    acquired: true,
    release,
    note: `took over a stale lock from pid ${held.pid ?? "?"} (${held.at ?? "unknown time"})`,
  };
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

/**
 * Pulls from a `sort=updated&direction=desc` listing, newest first, no older than `cutoffMs` (epoch
 * ms). `fetchPage` returns one page (1-based) or `[]` past the end. Stops as soon as a page holds a
 * pull older than the cutoff, since every pull after it, on this page or any later one, is older
 * still: the audit reads every pull in its own run window without reading a repo's whole history.
 */
export function pullsSince<P extends { updated_at: string }>(cutoffMs: number, fetchPage: (page: number) => P[]): P[] {
  const out: P[] = [];
  for (let page = 1; ; page++) {
    const batch = fetchPage(page);
    if (!batch.length) return out;
    for (const pull of batch) {
      if (Date.parse(pull.updated_at) < cutoffMs) return out;
      out.push(pull);
    }
  }
}

export function realDeps(factory: FactoryConfig, options: TickOptions, mode: RunMode = "local"): TickDeps {
  const runs = runsDir();
  mkdirSync(runs, { recursive: true });
  const evidenceInPrivate = relative("private", factory.evidence); // e.g. raw-artifacts
  const privateRepo = join(LAB_ROOT, "private");

  /** Worktree folder for a repo: its configured path, resolved from the lab's worktree. */
  const worktreeFor = (labWt: string, path: string) => resolve(labWt, path);

  /**
   * Refuses to start the agent unless both hooks run before every shell command and file edit, and
   * unless each hook, run once with payloads it must deny and allow, answers as it should and in time.
   */
  const requireHooks = (lab: string) => {
    const settings = join(lab, ".claude", "settings.json");
    const text = existsSync(settings) ? readFileSync(settings, "utf8") : "";
    const missing = hookProblems(text);
    if (missing.length) throw new Error(`the workspace's hooks aren't safe to run unattended: ${missing.join("; ")}`);
    const reviewed = Object.values(factory.repos).find((r) => r.guard === "reviewed");
    const reviewedFolder = reviewed ? worktreeFor(lab, reviewed.path) : lab;
    const limit = hookTimeoutSeconds(text);
    const failed = hookSelfTest(lab, reviewedFolder, limit, realHookRunner(lab, limit));
    if (failed.length) throw new Error(`the workspace's hooks failed their self-test: ${failed.join("; ")}`);
  };

  const deps: TickDeps = {
    now: () => new Date(),
    print: (line) => console.log(line),
    lock: () => acquireLock(runs),
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
    relabel: (github, number, remove, add) =>
      relabelWith(
        remove,
        add,
        (label) => gh("api", "-X", "DELETE", `repos/${github}/issues/${number}/labels/${encodeURIComponent(label)}`),
        (labels) => gh("issue", "edit", String(number), "--repo", github, ...labels.flatMap((l) => ["--add-label", l])),
      ),
    comment: (github, number, body) => {
      gh("issue", "comment", String(number), "--repo", github, "--body", body);
    },
    async qodoCheck(runId) {
      // Its own short-lived worktree, so the live answers reach the private repo's `main` even when
      // the check stops the run before the ticket's own workspace (and `ws.private`) ever exist, and
      // even on a clean run: `checkLiveQodoConfig` otherwise writes into this checkout's own `private/`,
      // which nothing else ever commits or pushes (Qodo on PR 145).
      const label = `qodo-check-${runId}`;
      const priv = join(runs, label, "private");
      try {
        mkdirSync(dirname(priv), { recursive: true });
        gitLong(privateRepo, "fetch", "--quiet", "origin", "main");
        gitLong(privateRepo, "worktree", "add", "-b", label, priv, "origin/main");
      } catch (error) {
        return {
          exitCode: 2 as const,
          message: `could not prepare a worktree to save Qodo's state: ${(error as Error).message}`,
          differences: [],
        };
      }
      const result = await checkLiveQodoConfig(factory, {
        snapshotDir: join(priv, "config"),
        evidenceRoot: join(priv, evidenceInPrivate),
      });
      let published: EvidencePush | null = null;
      try {
        published = commitAndPublish(priv, evidenceInPrivate, label, git, gitLong);
      } catch {
        // published stays null: the push itself failed (not merely a blocked path - our evidence is
        // always under an allowed root). Nothing is torn down below, so the worktree is the evidence's
        // only remaining copy, the same way `saveEvidence` keeps the run folder when its own push fails.
      }
      // Torn down only once the evidence actually reached the remote (`main`, or its own branch if a
      // blocked path forced that); otherwise the worktree is left for the owner to recover by hand
      // (Qodo on PR 145, round 2).
      if (published?.pushed || published?.savedAt) {
        git(privateRepo, "worktree", "remove", "--force", priv);
        git(privateRepo, "branch", "-D", label);
        rmSync(join(runs, label), { recursive: true, force: true });
      }
      return { exitCode: result.exitCode, message: result.message, differences: result.differences };
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
          gitLong(source, "fetch", "--quiet", "origin", "main");
          mainAtStart[key] = git(source, "rev-parse", "origin/main");
          mkdirSync(dirname(target), { recursive: true });
          gitLong(source, "worktree", "add", "--detach", target, "origin/main");
        }
        gitLong(privateRepo, "fetch", "--quiet", "origin", "main");
        mainAtStart[PRIVATE_KEY] = git(privateRepo, "rev-parse", "origin/main");
        gitLong(privateRepo, "worktree", "add", "-b", `run-${runId}`, priv, "origin/main");
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
      // The pulls endpoint has no `since`, so page through it by hand and stop once a page is older than
      // the window, instead of reading (or silently capping at) the repo's whole pull-request history.
      type Pull = { number: number; updated_at: string };
      type Review = { user?: { login: string }; submitted_at?: string; html_url: string };
      const cutoffMs = Math.floor(Date.parse(from) / 1000) * 1000;
      const reviews = Object.values(factory.repos).flatMap((repo) =>
        pullsSince<Pull>(
          cutoffMs,
          (page) =>
            JSON.parse(
              gh("api", `repos/${repo.github}/pulls?state=all&sort=updated&direction=desc&per_page=50&page=${page}`),
            ) as Pull[],
        )
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
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) killTree(child.pid);
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
            lastPr: null,
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
            lastPr,
          });
        });
      });
    },
    verifyPr(ws, repoKey, pr) {
      const repo = repoConfig(factory, repoKey);
      const { github } = repo;
      const first = JSON.parse(gh("pr", "view", String(pr), "--repo", github, "--json", "headRefOid,headRefName"));
      // The agent's branch tip is what it pushed; GitHub's view of the head can lag a push.
      const dir = repo.path === "." ? ws.lab : resolve(ws.lab, repo.path);
      let localTip: string | null = null;
      try {
        localTip = git(dir, "rev-parse", "--verify", `refs/heads/${String(first.headRefName)}`);
      } catch {
        localTip = null;
      }
      const pushed = commitToVerify(localTip, String(first.headRefOid));
      if (!pushed) return { problems: ["no commit id for the pull request's head"] };
      // review:wait runs in the run's worktree, so its evidence lands in the run's private branch.
      // --commit: it waits until GitHub shows the pushed commit, then for that commit's review.
      const review = npm(
        ws.lab,
        "run",
        "-s",
        "review:wait",
        "--",
        repoKey,
        String(pr),
        "--commit",
        pushed,
        "--timeout",
        "5",
      );
      const meaning: Record<number, string> = {
        1: "Qodo's review of the agent's last commit isn't complete, or the pull request's head never became it",
        2: "review:wait couldn't run",
        3: "Qodo skipped the review of the head commit",
      };
      if (review.status !== 0)
        return { problems: [meaning[review.status ?? 2] ?? `review:wait exited ${review.status}`] };
      // Read again after the review: state, head and checks must all be of the pushed commit.
      const view = JSON.parse(
        gh("pr", "view", String(pr), "--repo", github, "--json", "state,headRefOid,statusCheckRollup"),
      );
      const problems = prViewProblems(view, pushed);
      // A complete review can still have findings open: only none action-required counts as ready.
      const record = join(
        ws.lab,
        factory.evidence,
        "reviews",
        `${repoKey}-pr${pr}`,
        `${pushed.slice(0, 7)}.review.json`,
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
        gitLong(privateRepo, "fetch", "--quiet", "origin", "main");
        gitLong(privateRepo, "worktree", "add", "-b", `run-${runId}`, priv, "origin/main");
        temporary = true;
      }
      const dir = join(priv, evidenceInPrivate, "factory-runs");
      mkdirSync(dir, { recursive: true });
      for (const suffix of [".jsonl", ".agent.jsonl"]) {
        const file = join(runs, `${runId}${suffix}`);
        if (existsSync(file)) copyFileSync(file, join(dir, `${runId}${suffix}`));
      }
      const result = commitAndPublish(priv, evidenceInPrivate, runId, git, gitLong);
      // Torn down once the evidence reached origin, whether that's main or a blocked run's own branch;
      // only when even that push failed is the worktree the owner's sole remaining copy (Qodo on PR 141).
      if ((result.pushed || result.savedAt) && temporary) {
        git(privateRepo, "worktree", "remove", "--force", priv);
        git(privateRepo, "branch", "-D", `run-${runId}`);
        rmSync(join(runs, runId), { recursive: true, force: true });
      }
      return { file: evidenceFile(factory, runId), ...result };
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
        gitLong(dir, "fetch", "--quiet", "origin", "main");
        const head = git(dir, "rev-parse", "HEAD");
        const main = git(dir, "rev-parse", "origin/main");
        if (head !== main)
          throw new Error(`the ${key} checkout is at ${head.slice(0, 7)}, not origin/main ${main.slice(0, 7)}`);
        if (!existsSync(join(dir, "node_modules")) && existsSync(join(dir, "package.json")))
          throw new Error(`the ${key} checkout has no node_modules: the workflow must run npm ci first`);
        mainAtStart[key] = main;
      }
      gitLong(privateRepo, "fetch", "--quiet", "origin", "main");
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
  if (outcome === "done" || outcome === "needs-help") {
    // After a finished run, ask whether the saved reviews now repeat a pattern worth a rule. The
    // owner decides on the proposal ticket; a failure here is reported and never changes the
    // run's outcome or labels.
    try {
      proposeAfterRun(LAB_ROOT, console.log);
    } catch (error) {
      console.error(
        `rules:propose failed (run outcome unchanged): ${error instanceof Error ? (error.stack ?? error.message) : error}`,
      );
    }
  }
  process.exit(outcome === "needs-help" ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();

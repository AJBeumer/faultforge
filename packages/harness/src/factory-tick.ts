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
 *
 * Exit codes: 0 the tick ended normally (a run delivered, or nothing to take: busy, idle, a ticket refused or
 * not ready, each logged); 1 a run stopped and needs the owner (`agent-needs-help`); 2 the command line or the
 * environment was wrong, so no tick ran.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AgentRun } from "./factory-agent.ts";
import { type FactoryConfig, loadFactory, repoConfig } from "./factory-config.ts";
import { realDeps } from "./factory-deps.ts";
import { type EvidencePush, evidenceFile } from "./factory-evidence.ts";
import { HooksCheckError, type HooksReport, hooksEvent } from "./factory-hooks.ts";
import { recoverStranded } from "./factory-recovery.ts";
import type { RelabelProblems } from "./factory-relabel.ts";
import type { Verification } from "./factory-verify.ts";
import type { RunMode } from "./factory-workspace.ts";
import { telltales } from "./neutral.ts";
import { ROOT as LAB_ROOT } from "./paths.ts";
import { type Difference, summarizeDifference } from "./qodo-check.ts";
import { proposeAfterRun } from "./rules-propose.ts";
import { provenanceProblems, type TicketSnapshot, ticketChangeProblems } from "./ticket-snapshot.ts";

export const LABELS = {
  ready: "ready-for-agent",
  working: "agent-working",
  done: "agent-done",
  help: "agent-needs-help",
} as const;

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
  const { problems, ownerGates = [] } = verify(number);
  if (problems.length) {
    return {
      label: LABELS.help,
      reason: `the agent reported "${result.outcome}", but ${problems.join("; ")}`,
      pr: result.pr,
    };
  }
  // The runner's own gates hold a PR the agent called ready (#215).
  const waits = [...(result.outcome === "ready" ? [] : [result.reason]), ...ownerGates];
  return {
    label: LABELS.done,
    reason: waits.length
      ? `waiting for the owner: ${waits.join("; ")}`
      : "the pull request is ready for the owner to merge",
    pr: result.pr,
  };
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

/** A sortable run id from the start time and the ticket, e.g. `20261109-093012-target-18`. */
export function runIdFor(now: Date, repoKey: string, number: number): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${repoKey}-${number}`;
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
  /** What the hook self-test saw, logged as `hooks-checked` before the agent starts. */
  hooks?: HooksReport;
}

/** What `qodo:check` found: `exitCode` 0 means it matches the snapshot, 1 a difference was found (each
 * one in `differences`), 2 it couldn't be checked at all (no key, no snapshot, an API or parse error).
 * Kept structured, not pre-formatted: a difference's full detail (a rule's name and `content`, its field
 * values) can hold text from private storage, so it never goes to a ticket comment (Qodo on PR 145) or to
 * the run log, which CI prints and uploads from a public repository (#187). Both use `summarizeDifference`;
 * the full detail is in the private `qodo-state` evidence. */
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
    const recovery = recoverStranded(Object.values(factory.repos), deps);
    if (recovery.recovered.length || recovery.failed.length) log("recovered", recovery);
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
    // An earlier run's result label goes too: a ticket carries one state at a time (#197).
    relabel([LABELS.ready, LABELS.help, LABELS.done], [LABELS.working]);
    say(
      `Picked up by scheduled agent run \`${runId}\`. Limits: ${options.minutes} minutes, three review rounds. It will report here when it stops; merging stays with the owner.`,
    );
    log("claimed", { limits: { minutes: options.minutes, budgetUsd: options.budget, reviewRounds: 3 } });

    const qodo = await deps.qodoCheck(runId);
    // A summary only, here too: CI prints this log and uploads it from a public repo, and a rule's name
    // or content can hold text read from private storage. The full state is in the saved Qodo evidence.
    log("qodo-checked", {
      exitCode: qodo.exitCode,
      message: qodo.message,
      differences: qodo.differences.map(summarizeDifference),
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
    if (ws.hooks) log("hooks-checked", hooksEvent(ws.hooks));

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
        log("verified", {
          pr,
          problems: verification.problems,
          revertCheckRecord: verification.revertCheckRecord ?? null,
        });
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
      // A run that needs help keeps its worktrees, as its log says: they may hold its only copy (#197).
      if (saved.savedAt && finish.label === LABELS.done) deps.cleanup(ws);
      return "needs-help";
    }
    if (finish.label === LABELS.done) deps.cleanup(ws);
    return finish.label === LABELS.done ? "done" : "needs-help";
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    if (error instanceof HooksCheckError) log("hooks-checked", hooksEvent(error.report));
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

/** `--minutes` and `--budget`, each a positive number, falling back to the given default; exits 2
 * naming whichever one isn't. */
function positiveOption(values: Record<string, unknown>, name: "minutes" | "budget", fallback: number): number {
  const value = values[name] === undefined ? fallback : Number(values[name]);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(
      `usage: npm run factory:tick -- [--ci] [--minutes N] [--budget USD]   (--${name} must be a positive number)`,
    );
    process.exit(2);
  }
  return value;
}

async function main() {
  let values: { ci?: boolean; minutes?: string; budget?: string };
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: { ci: { type: "boolean" }, minutes: { type: "string" }, budget: { type: "string" } },
    }));
  } catch (error) {
    console.error(
      `usage: npm run factory:tick -- [--ci] [--minutes N] [--budget USD]   (${error instanceof Error ? error.message : error})`,
    );
    process.exit(2);
  }
  const options = { minutes: positiveOption(values, "minutes", 120), budget: positiveOption(values, "budget", 25) };
  const mode: RunMode = values.ci ? "ci" : "local";
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

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
 *  9. Save the run log to the private repo, then label the ticket `agent-done` (only once it is saved) or
 *     `agent-needs-help`, comment why, and clean up (worktrees are kept when the run needs help).
 *
 * Every step is appended with a UTC time to `<runs>/<run id>.jsonl` as it happens, and saved under
 * `<evidence>/factory-runs/`; the saved copy ends with the outcome the ticket shows (`factory-finish.ts`).
 * `npm run factory:timeline` prints it as a table.
 *
 * Needs GH_TOKEN (or GH_TOKEN_FILE) and QODO_KEY_FILE in the environment. Never merges.
 *
 * Exit codes: 0 the tick ended and its ticket, if any, doesn't need the owner (a run delivered `agent-done`,
 * or nothing to take: busy, idle, or a ticket refused, each logged); 1 the ticket it took now carries
 * `agent-needs-help`: a run stopped, or the ticket isn't ready; 2 the command line or the environment was
 * wrong (a bad option, no token, a token file that can't be read, a config that doesn't load), so no tick
 * ran; 3 the tick itself failed (an error in the runner, before or after it picked a ticket; a claimed ticket
 * is labelled `agent-needs-help` and the log says so).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AgentRun } from "./factory-agent.ts";
import { type FactoryConfig, loadFactory, repoConfig } from "./factory-config.ts";
import { realDeps } from "./factory-deps.ts";
import { type EvidencePush, evidenceFile } from "./factory-evidence.ts";
import { finishRun } from "./factory-finish.ts";
import { HooksCheckError, type HooksReport, hooksEvent } from "./factory-hooks.ts";
import { recoverStranded } from "./factory-recovery.ts";
import type { RelabelProblems } from "./factory-relabel.ts";
import {
  type Candidate,
  exitCodeFor,
  type Finish,
  type IssueEvent,
  LABELS,
  lastLabelled,
  oldest,
  parseAgentResult,
  QODO_CHECK_COMMENT,
  redact,
  runIdFor,
  safeText,
  settle,
  type TickOutcome,
} from "./factory-settle.ts";
import type { Verification } from "./factory-verify.ts";
import type { RunMode } from "./factory-workspace.ts";
import { ROOT as LAB_ROOT } from "./paths.ts";
import { type Difference, summarizeDifference } from "./qodo-check.ts";
import { proposeAfterRun } from "./rules-propose.ts";
import { provenanceProblems, type TicketSnapshot, ticketChangeProblems } from "./ticket-snapshot.ts";

export {
  type AgentResult,
  type Candidate,
  EXIT_CODES,
  exitCodeFor,
  type Finish,
  type IssueEvent,
  LABELS,
  lastLabelled,
  oldest,
  parseAgentResult,
  prNumber,
  QODO_CHECK_COMMENT,
  redact,
  runIdFor,
  SECRET_NAMES,
  safeText,
  settle,
  type TickOutcome,
} from "./factory-settle.ts";

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
  lock(): { acquired: boolean; release(): void; refresh?(): void; note?: string };
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
  let finishedLogged = false;
  const log: Logger = (event, detail = {}) => {
    // Every logged value is scrubbed of the secrets in the environment: the log can be public.
    const entry = JSON.parse(redact(JSON.stringify({ t: deps.now().toISOString(), event, ...detail })));
    const shown = Object.keys(detail).length ? ` ${redact(JSON.stringify(detail))}` : "";
    deps.print(`${entry.t} ${event}${shown}`);
    if (runId) deps.record(runId, entry);
    // Every step is a heartbeat too: the lock's timer can't fire while a long synchronous step runs.
    lock.refresh?.();
  };
  /** `saved` only once the copy reached the private repo, on `main` or on a branch of its own. */
  const logSaved = (saved: EvidencePush, id: string) => {
    if (saved.pushed || saved.savedAt) log("saved", { evidence: evidenceFile(factory, id), savedAt: saved.savedAt });
    else log("error", { message: "the run log reached neither the private repo's main nor a branch of its own" });
  };
  /** Copies the run log to private storage, after its outcome is logged; `saved` is logged after the push. */
  const saveLog = (id: string) => logSaved(deps.saveEvidence(id, null), id);
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
    const id = runIdFor(deps.now(), pick.repoKey, pick.number);
    runId = id;
    const reviewed = repoConfig(factory, pick.repoKey).guard === "reviewed";
    const say = (body: string) => deps.comment(pick.github, pick.number, safeText(body, reviewed));
    // The new label is added before the old ones go (`relabelWith`). A failed removal is logged: the old
    // label lingers beside the new one. A failed add throws, for the caller to treat as any other failure:
    // never proceeding as if the ticket now shows what it doesn't. Returns whether the removal worked too.
    const relabel = (remove: string[], add: string[]) => {
      const { removeFailed, addFailed } = deps.relabel(pick.github, pick.number, remove, add);
      if (removeFailed) {
        log("error", {
          message: `couldn't remove a label from the ticket: ${removeFailed instanceof Error ? removeFailed.message : removeFailed}`,
        });
      }
      if (addFailed) throw addFailed instanceof Error ? addFailed : new Error(String(addFailed));
      return !removeFailed;
    };
    /** Takes `ready-for-agent` off a ticket that won't run, and comments only once that worked: while the
     * label stays, the next tick meets the ticket again, and a comment on every tick would repeat (#245). */
    const turnAway = (
      outcome: "refused" | "not-ready",
      add: string[],
      body: string,
      detail: Record<string, unknown>,
    ) => {
      if (relabel([LABELS.ready], add)) say(body);
      else log("error", { message: "no comment until the label is off, so it is posted once" });
      if (add.length) finalLabel = LABELS.help;
      log(outcome, detail);
      saveLog(id);
      return outcome;
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
      return turnAway(
        "refused",
        [],
        `Not started. The \`${LABELS.ready}\` label was added by ${pick.labelledBy}, and only the repository owner can start an agent run. The label has been removed.`,
        { reason: `label added by ${pick.labelledBy}, not the owner ${owner}` },
      );
    }

    const authors = provenanceProblems(deps.snapshot(pick.github, pick.number).provenance, owner);
    if (authors.length) {
      return turnAway(
        "refused",
        [],
        `Not started. An agent run follows this ticket's text, so only a ticket written, edited and commented on by the repository owner can start one (${authors.join("; ")}). The label has been removed.`,
        { reason: authors.join("; ") },
      );
    }

    const readiness = deps.ready(pick.repoKey, pick.number);
    if (readiness.problems.length) {
      return turnAway(
        "not-ready",
        [LABELS.help],
        `Not started: this ticket isn't ready yet.\n\n${readiness.problems.map((p) => `- ${p}`).join("\n")}\n\nFix the ticket and add \`${LABELS.ready}\` again.`,
        { problems: readiness.problems },
      );
    }

    claimed = pick;
    // An earlier run's result label goes too: a ticket carries one state at a time (#197).
    relabel([LABELS.ready, LABELS.help, LABELS.done], [LABELS.working]);
    say(
      `Picked up by scheduled agent run \`${id}\`. Limits: ${options.minutes} minutes, three review rounds. It will report here when it stops; merging stays with the owner.`,
    );
    log("claimed", { limits: { minutes: options.minutes, budgetUsd: options.budget, reviewRounds: 3 } });

    const qodo = await deps.qodoCheck(id);
    // Summaries only, in the log, and a fixed sentence on the ticket: CI prints this log and uploads it from
    // a public repo, and a rule's name or content can hold text read from private storage.
    const differences = qodo.differences.map(summarizeDifference);
    log("qodo-checked", { exitCode: qodo.exitCode, message: qodo.message, differences });
    if (qodo.exitCode !== 0) {
      relabel([LABELS.working, LABELS.ready], [LABELS.help]);
      finalLabel = LABELS.help;
      say(QODO_CHECK_COMMENT);
      const reason = qodo.exitCode === 2 ? "Qodo's configuration couldn't be checked" : "Qodo's configuration drifted";
      log("finished", { label: LABELS.help, reason: `${reason} (${qodo.message})`, pr: null });
      finishedLogged = true;
      saveLog(id);
      return "needs-help";
    }

    ws = deps.workspace(id);
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
    const agent = await deps.runAgent(ws, id, pick.repoKey, pick.number, ticketFile, log);
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
    const label = finishRun({
      factory,
      deps,
      runId: id,
      ws: workspace,
      finish,
      log,
      relabel,
      say,
      reviewed,
      labelled: (l) => {
        finalLabel = l;
      },
      finished: () => {
        finishedLogged = true;
      },
    });
    return label === LABELS.done ? "done" : "needs-help";
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
      } else finalLabel = LABELS.help;
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
    if (runId && !finishedLogged) {
      // The saved log ends with how the run ended: the label the ticket now shows (AUD-M18).
      log("finished", { label: finalLabel, reason: `the runner failed (${message})`, pr: null, by: "runner" });
      try {
        const saved = deps.saveEvidence(runId, ws);
        if (saved.blocked.length) log("evidence-blocked", { blocked: saved.blocked, savedAt: saved.savedAt ?? null });
        logSaved(saved, runId);
      } catch {
        // The live log under the runs folder still has everything.
      }
    }
    return "failed";
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

/**
 * GH_TOKEN, or the content of the file GH_TOKEN_FILE names, or why neither can be had. A token file that is
 * missing or empty is the environment being wrong (exit 2), never a crash that reads as a failed run.
 */
export function tokenFrom(
  env: Record<string, string | undefined>,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): { token: string } | { problem: string } {
  if (env.GH_TOKEN) return { token: env.GH_TOKEN };
  if (!env.GH_TOKEN_FILE) return { problem: "factory:tick needs GH_TOKEN or GH_TOKEN_FILE." };
  try {
    const token = read(env.GH_TOKEN_FILE).trim();
    return token ? { token } : { problem: "factory:tick: the file GH_TOKEN_FILE names is empty." };
  } catch (error) {
    return { problem: `factory:tick can't read GH_TOKEN_FILE (${(error as NodeJS.ErrnoException).code ?? "error"}).` };
  }
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
  const auth = tokenFrom(process.env);
  if ("problem" in auth) {
    console.error(auth.problem);
    process.exit(2);
  }
  process.env.GH_TOKEN = auth.token;
  let factory: FactoryConfig;
  let deps: TickDeps;
  try {
    factory = loadFactory();
    deps = realDeps(factory, options, mode);
  } catch (error) {
    console.error(`factory:tick couldn't set up: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
  const outcome = await tick(factory, deps, options);
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
  process.exit(exitCodeFor(outcome));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();

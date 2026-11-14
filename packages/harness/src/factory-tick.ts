/**
 * One tick of the unattended factory. GitHub Actions runs it every 15 minutes (`.github/workflows/factory.yml`):
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
 * Split along its seams (#109): `factory-tick-deps.ts` (what a tick needs from the world), `factory-tick-pick.ts`
 * (steps 2 and 3), `factory-workspace.ts` (step 6), `factory-tick-run.ts` (step 7, and step 8's audit and
 * verification, which `factory-settle.ts` turns into an outcome), `factory-finish.ts` (step 9),
 * `factory-tick-failure.ts` (a tick that throws) and `factory-tick-setup.ts` (the command's own checks). This
 * module runs the steps in order.
 *
 * Exit codes: 0 the tick ended and its ticket, if any, doesn't need the owner (a run delivered `agent-done`,
 * or nothing to take: busy, idle, or a ticket refused, each logged); 1 the ticket it took now carries
 * `agent-needs-help`: a run stopped, or the ticket isn't ready; 2 the command line or the environment was
 * wrong (a bad option, no token, a token file that can't be read, a config that doesn't load), so no tick
 * ran; 3 the tick itself failed (an error in the runner, before or after it picked a ticket; a claimed ticket
 * is labelled `agent-needs-help` and the log says so), or an unexpected error anywhere, even while loading:
 * `npm run factory:tick` runs `factory-tick-cli.ts`, which loads this module inside `cli-entry.ts`.
 */
import { parseArgs } from "node:util";
import { claimMarker } from "./factory-comments.ts";
import { type FactoryConfig, loadFactory, repoConfig } from "./factory-config.ts";
import { realDeps } from "./factory-deps.ts";
import { type EvidencePush, evidenceFile } from "./factory-evidence.ts";
import { finishRun } from "./factory-finish.ts";
import { hooksEvent } from "./factory-hooks.ts";
import { recoverStranded } from "./factory-recovery.ts";
import {
  type Candidate,
  exitCodeFor,
  LABELS,
  oldest,
  QODO_CHECK_COMMENT,
  redact,
  runIdFor,
  safeText,
  type TickOutcome,
} from "./factory-settle.ts";
import type { Logger, TickDeps, TickOptions, Workspace } from "./factory-tick-deps.ts";
import { failTick } from "./factory-tick-failure.ts";
import { admissionRefusal, readyCandidates } from "./factory-tick-pick.ts";
import { checkRun, runOnTicket } from "./factory-tick-run.ts";
import { positiveOption, setupRefusal, tokenFrom } from "./factory-tick-setup.ts";
import type { RunMode } from "./factory-workspace.ts";
import { ROOT as LAB_ROOT } from "./paths.ts";
import { summarizeDifference } from "./qodo-check.ts";
import { proposeAfterRun } from "./rules-propose.ts";

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

export type { Logger, QodoCheckOutcome, TickDeps, TickOptions, Workspace } from "./factory-tick-deps.ts";
export { setupRefusal, tokenFrom } from "./factory-tick-setup.ts";

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
  // Whether a copy of the log that ends with the outcome reached the private repo (`saved` is logged then).
  let copied = false;
  const log: Logger = (event, detail = {}) => {
    // Every logged value is scrubbed of the secrets in the environment: the log can be public.
    const entry = JSON.parse(redact(JSON.stringify({ t: deps.now().toISOString(), event, ...detail })));
    const shown = Object.keys(detail).length ? ` ${redact(JSON.stringify(detail))}` : "";
    deps.print(`${entry.t} ${event}${shown}`);
    if (runId) deps.record(runId, entry);
    if (event === "saved") copied = true;
    // Every step is a heartbeat too: the lock's timer can't fire while a long synchronous step runs. A
    // heartbeat that fails never stops the run (Qodo on PR 262).
    try {
      lock.refresh?.();
    } catch {
      // The next step or the timer tries again.
    }
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
    if (recovery.recovered.length || recovery.failed.length || recovery.otherMode) log("recovered", recovery);
    const candidates = readyCandidates(factory, deps);
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
      const off = relabel([LABELS.ready], add);
      // Set as soon as the label is on, so a failing comment can't leave the log saying no label (Qodo on PR 262).
      if (add.length) finalLabel = LABELS.help;
      if (!off) log("error", { message: "no comment until the label is off, so it is posted once" });
      else {
        try {
          say(body);
        } catch (error) {
          log("error", {
            message: `couldn't comment on the ticket: ${error instanceof Error ? error.message : error}`,
          });
        }
      }
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

    const refusal = admissionRefusal(pick, deps);
    if (refusal) return turnAway(refusal.outcome, refusal.add, refusal.body, refusal.detail);
    const owner = pick.github.split("/")[0] ?? "";

    claimed = pick;
    // An earlier run's result label goes too: a ticket carries one state at a time (#197).
    relabel([LABELS.ready, LABELS.help, LABELS.done], [LABELS.working]);
    // The claim says which way of running took it, so the other's recovery leaves it alone (AUD-M19).
    const mark = deps.mode ? `\n\n${claimMarker(deps.mode)}` : "";
    say(
      `Picked up by scheduled agent run \`${id}\`. Limits: ${options.minutes} minutes, three review rounds. It will report here when it stops; merging stays with the owner.${mark}`,
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

    const workspace = ws;
    const run = { deps, ws: workspace, pick, owner, runId: id, log };
    const finish = checkRun(run, await runOnTicket(run), options.minutes);
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
    return failTick(error, { factory, deps, log, runId, claimed, ws, finalLabel, finishedLogged, copied, logSaved });
  } finally {
    lock.release();
  }
}

/** The command: `factory-tick-cli.ts` runs it, so an unexpected error, even while loading, is exit 3. */
export async function main(argv: string[]): Promise<number> {
  let values: { ci?: boolean; minutes?: string; budget?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
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
  const refusal = setupRefusal(deps);
  if (refusal) {
    console.error(refusal);
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
  return exitCodeFor(outcome);
}

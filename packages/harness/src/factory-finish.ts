/**
 * The end of a run that reached the agent: save its evidence, then label the ticket from what was saved,
 * report it, log the outcome, and copy the log once more so the saved copy ends with that outcome. Split from
 * factory-tick.ts, which may not grow (CLAUDE.md, module size rule).
 *
 * The order is the point (AUD-M18, #245):
 *  1. The run log and transcript go to private storage first. `agent-done` is set only once they are there;
 *     a failed or blocked save ends `agent-needs-help`, so a ticket never says done for a run with no record.
 *  2. The label (added before the old one is removed, `relabelWith`), then the comment.
 *  3. `finished`, with the label the ticket now carries, is the log's last event before the final copy.
 *  4. The final copy; `saved` is logged after its push, so it is in the live log only.
 *  5. Cleanup, after the copy: the private worktree it removes is where the copy is made.
 */

import type { FactoryConfig } from "./factory-config.ts";
import { evidenceFile } from "./factory-evidence.ts";
import { type Finish, LABELS, safeText } from "./factory-settle.ts";
import type { Logger, TickDeps, Workspace } from "./factory-tick.ts";

export interface FinishContext {
  factory: FactoryConfig;
  deps: TickDeps;
  runId: string;
  ws: Workspace;
  finish: Finish;
  log: Logger;
  /** Adds the new label before removing the old ones; throws when the add failed. */
  relabel(remove: string[], add: string[]): void;
  /** Comments on the ticket, sanitised for a reviewed repo. */
  say(body: string): void;
  reviewed: boolean;
  /** Told the ticket's final label as soon as it is set, so a later failure never adds a second one. */
  labelled(label: string): void;
  /** Told once the outcome has been logged, so a later failure never logs a second one. */
  finished(): void;
}

const message = (error: unknown): string =>
  error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);

/** Saves, labels, reports and copies the log, in that order. Returns the ticket's final label. */
export function finishRun(c: FinishContext): typeof LABELS.done | typeof LABELS.help {
  const { deps, runId, ws, finish, log } = c;
  let saved: ReturnType<TickDeps["saveEvidence"]> | null = null;
  try {
    saved = deps.saveEvidence(runId, ws);
  } catch (error) {
    // The error stays in the run log: a git error about the private repo can name its paths and URL, and
    // the comment below can be on a public ticket (Qodo on PR 262).
    log("error", { message: `couldn't save the run's evidence: ${message(error)}` });
  }
  let label: typeof LABELS.done | typeof LABELS.help = finish.label;
  let reason = finish.reason;
  let note = "";
  if (saved?.blocked.length) {
    log("evidence-blocked", { blocked: saved.blocked, savedAt: saved.savedAt ?? null });
    label = LABELS.help;
    const where = saved.savedAt
      ? `the private repository's \`${saved.savedAt}\` branch`
      : `the run folder (\`${ws.root}\`), kept for inspection`;
    reason = `${finish.label === LABELS.done ? `${finish.reason}, but ` : `${finish.reason}; also, `}the run changed files in the private repository outside the evidence folders`;
    // Sanitised on its own, so a protected word among the paths only blanks this clause (Qodo on PR 141).
    const paths = safeText(saved.blocked.join(", "), c.reviewed);
    note = `\n\nThe run changed files in the private repository outside \`raw-artifacts/\` and \`factory-log/\` (${paths}). Nothing was pushed to its \`main\`; the run log and transcript are saved instead in ${where}.`;
  } else if (!saved?.pushed) {
    label = LABELS.help;
    reason = `${finish.reason}; but the run's evidence couldn't be saved to the private repository (the run log has the error), so its folder is kept`;
  }
  c.relabel([LABELS.working, LABELS.ready], [label]);
  c.labelled(label);
  const prLine = finish.pr ? `\n\nPull request: ${finish.pr}` : "";
  try {
    c.say(
      label === LABELS.done
        ? `Agent run \`${runId}\` finished: ${reason}.${prLine}`
        : `Agent run \`${runId}\` stopped and needs help: ${reason}.${prLine}${note}`,
    );
  } catch (error) {
    log("error", { message: `couldn't report on the ticket: ${message(error)}` });
  }
  log("finished", { label, reason, pr: finish.pr });
  c.finished();
  // The final copy: the one that ends with `finished`. When it doesn't reach the private repo, the saved
  // copy lacks the outcome, so the run's folder is kept as the only full record (Qodo on PR 262).
  let finalSaved = false;
  try {
    const copy = deps.saveEvidence(runId, ws);
    finalSaved = Boolean(copy.pushed || copy.savedAt);
  } catch (error) {
    log("error", { message: `couldn't save the final copy of the run log: ${message(error)}` });
  }
  if (finalSaved) log("saved", { evidence: evidenceFile(c.factory, runId) });
  else log("error", { message: "the final copy of the run log didn't reach the private repo; the run folder is kept" });
  // A run that needs help keeps its worktrees (#197), unless it was done and only its evidence was
  // blocked, and that evidence reached its own branch: then the folder holds nothing the branch doesn't.
  const blockedButSaved = finish.label === LABELS.done && saved?.blocked.length && saved.savedAt;
  const keep = !finalSaved || (label === LABELS.help && !blockedButSaved);
  if (keep) {
    log("kept", { root: ws.root });
    return label;
  }
  try {
    deps.cleanup(ws);
    log("cleanup", { root: ws.root });
  } catch (error) {
    // Not the run's failure, so the outcome stands; but the saved log must say it, so it gets one more copy
    // (Qodo on PR 262), through the run's own private worktree when it is still there (the cleanup removes it
    // first; a copy that can't be made is logged). Never through a fresh one: that would clash with the run's
    // branch and remove the run folder the cleanup couldn't.
    log("error", { message: `couldn't clean up the run's worktrees: ${message(error)}` });
    try {
      const copy = deps.saveEvidence(runId, ws);
      if (copy.pushed || copy.savedAt) log("saved", { evidence: evidenceFile(c.factory, runId) });
    } catch (inner) {
      log("error", { message: `couldn't save the log once more: ${message(inner)}` });
    }
  }
  return label;
}

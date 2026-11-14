/**
 * How a factory tick ends when something throws (`factory-tick.ts`): the error is logged; a claimed ticket
 * that has no final label yet gets `agent-needs-help` and a comment, each tried on its own; and the run log is
 * saved with how the run ended, unless a copy that ends with the outcome already reached the private repo.
 */
import type { FactoryConfig } from "./factory-config.ts";
import { repoConfig } from "./factory-config.ts";
import type { EvidencePush } from "./factory-evidence.ts";
import { HooksCheckError, hooksEvent } from "./factory-hooks.ts";
import { type Candidate, LABELS, RunnerStop, safeText } from "./factory-settle.ts";
import type { Logger, TickDeps, Workspace } from "./factory-tick-deps.ts";

/** What the tick knew when it failed. */
export interface FailedTick {
  factory: FactoryConfig;
  deps: TickDeps;
  log: Logger;
  runId: string | null;
  claimed: Candidate | null;
  ws: Workspace | null;
  /** The label the ticket already carries as its outcome, if any. */
  finalLabel: string | null;
  /** Whether `finished` is already in the log. */
  finishedLogged: boolean;
  /** Whether a copy of the log that ends with the outcome already reached the private repo. */
  copied: boolean;
  /** Logs `saved` once the copy reached the private repo, or an error when it didn't. */
  logSaved: (saved: EvidencePush, id: string) => void;
}

/** Reports a tick that threw, as described above. Never throws on a failed report: the live log has it all. */
export function failTick(error: unknown, tick: FailedTick): "failed" {
  const { deps, log, runId, claimed } = tick;
  let finalLabel = tick.finalLabel;
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
      const reviewed = repoConfig(tick.factory, claimed.repoKey).guard === "reviewed";
      deps.comment(
        claimed.github,
        claimed.number,
        // Only the runner's own words reach the ticket; any other error stays in the run log, since it can
        // name private paths or URLs (Qodo on PR 262).
        safeText(
          error instanceof RunnerStop
            ? `Agent run \`${runId}\` stopped and needs help: ${message}.`
            : `Agent run \`${runId}\` stopped and needs help: the runner failed; the run log has the error.`,
          reviewed,
        ),
      );
    } catch (inner) {
      log("error", { message: `couldn't report on the ticket: ${inner instanceof Error ? inner.message : inner}` });
    }
  }
  // The saved log ends with how the run ended: the label the ticket now shows (AUD-M18). A copy that
  // failed after the outcome was logged is tried once more here (Qodo on PR 262).
  if (runId && !tick.copied) {
    if (!tick.finishedLogged)
      log("finished", { label: finalLabel, reason: `the runner failed (${message})`, pr: null, by: "runner" });
    try {
      const saved = deps.saveEvidence(runId, tick.ws);
      if (saved.blocked.length)
        log("evidence-blocked", { files: saved.blocked.length, savedAt: saved.savedAt ?? null });
      tick.logSaved(saved, runId);
    } catch {
      // The live log under the runs folder still has everything.
    }
  }
  return "failed";
}

/**
 * Moving a ticket's labels, where a failed removal and a failed add mean different things. Split from
 * factory-tick.ts (#227).
 */
import { ExternalCallError } from "./github.ts";

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

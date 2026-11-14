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

/** What went wrong adding or removing a ticket's labels, or null for either that didn't. A failed add means
 * the ticket's new state was never recorded, so nothing was removed either: the ticket still shows its old
 * state, where a later tick (or recovery) finds it. A failed removal after a good add only leaves an old
 * label beside the new one, safe to log and retry: never a ticket with no factory label at all. */
export interface RelabelProblems {
  removeFailed: unknown;
  addFailed: unknown;
}

/**
 * Adds `add` with `addAll` first, and only once that worked removes each of `remove` with `removeOne`
 * (AUD-M19). The other order left a ticket with no factory label when the add failed after a removal, and
 * nothing looks for such a ticket. A label in both lists is kept. Never throws: both failures (a removal
 * other than `isLabelAlreadyGone`, or the add itself) are returned, so the caller can treat them differently.
 */
export function relabelWith(
  remove: string[],
  add: string[],
  removeOne: (label: string) => void,
  addAll: (labels: string[]) => void,
): RelabelProblems {
  if (add.length) {
    try {
      addAll(add);
    } catch (error) {
      return { removeFailed: null, addFailed: error };
    }
  }
  let removeFailed: unknown = null;
  for (const label of remove.filter((l) => !add.includes(l))) {
    try {
      removeOne(label);
    } catch (error) {
      if (!isLabelAlreadyGone(error)) removeFailed ??= error;
    }
  }
  return { removeFailed, addFailed: null };
}

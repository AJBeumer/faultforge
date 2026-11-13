/**
 * The polling behind `review:wait`: waiting for the PR head to become a commit, and for Qodo's review of
 * it to finish. Every read is passed in, so the waits run without a network or a clock in the tests.
 */
import { type QodoReview, reviewState } from "./qodo-review.ts";

export interface WaitDeps {
  fetchReview: () => Promise<QodoReview>;
  /** Called on every poll; return the comment's `updated_at` to have new versions saved. */
  onPoll?: () => Promise<void>;
  /** Called when a poll fails; the wait goes on until the deadline. */
  onError?: (error: unknown) => void;
  /**
   * The PR's head now. When given, a finished review counts only if the head is still `headSha`:
   * someone may have pushed again while Qodo was reviewing (PR 98).
   */
  readHead?: () => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type WaitResult =
  | { state: "complete" | "skipped"; review: QodoReview; polls: number; seenCompleteAt: number }
  | { state: "moved"; head: string; review: QodoReview; polls: number }
  | { state: "timeout"; review: QodoReview | undefined; polls: number };

/**
 * Polls until the review of `headSha` is complete or `timeoutMs` has passed.
 * A failed poll is reported and retried. A finished review is reported only once its comments were saved
 * after it finished, and, with `readHead`, only while the head is still `headSha` ("moved" otherwise).
 * At the deadline, the last error is thrown if no poll succeeded or the final save never did.
 */
export async function waitForReview(
  headSha: string,
  deps: WaitDeps,
  { timeoutMs = 20 * 60_000, intervalMs = 20_000 } = {},
): Promise<WaitResult> {
  const deadline = deps.now() + timeoutMs;
  let review: QodoReview | undefined;
  let lastError: unknown;
  let seenCompleteAt: number | undefined;
  let polls = 0;
  const save = async () => {
    try {
      await deps.onPoll?.();
      return true;
    } catch (error) {
      lastError = error;
      deps.onError?.(error);
      return false;
    }
  };
  for (;;) {
    polls++;
    await save();
    try {
      review = await deps.fetchReview();
      const state = reviewState(review, headSha);
      if (state === "complete" || state === "skipped") {
        // Qodo gives no end time; this is when it was first seen finished, at most one interval late.
        seenCompleteAt ??= deps.now();
        if (deps.readHead) {
          const head = await deps.readHead();
          if (!sameCommit(head, headSha)) return { state: "moved", head, review, polls };
        }
        // One last save: Qodo may have edited its comment between the poll and this answer.
        if (await save()) return { state, review, polls, seenCompleteAt };
      }
    } catch (error) {
      lastError = error;
      deps.onError?.(error);
    }
    if (deps.now() + intervalMs > deadline) {
      if (lastError !== undefined && (review === undefined || seenCompleteAt !== undefined)) throw lastError;
      return { state: "timeout", review, polls };
    }
    await deps.sleep(intervalMs);
  }
}

export type HeadWaitResult =
  | {
      state: "reached" | "moved" | "timeout";
      /** The PR head at the last read: the full id of the commit waited for, or the one that stopped the wait. */
      head: string;
      polls: number;
      /** Every distinct head seen, in order. */
      seen: string[];
    }
  | { state: "failed"; head: null; polls: number; seen: []; error: string };

/** True when `head` (a full id) is the commit `target` names, in full or by a prefix of at least 7. */
export function sameCommit(head: string, target: string): boolean {
  return target.length >= 7 && head.toLowerCase().startsWith(target.toLowerCase());
}

/**
 * Polls the PR head until it is `target`. Right after a push GitHub can show the previous head for a
 * moment: on PR 65 a wait started within a second of a push reported the old commit's finished review
 * as the answer. That first head is waited out. Any other head means someone pushed again: "moved".
 * A failed read is reported and retried; if no read succeeded by the deadline, the result is "failed"
 * with the last error, so the caller can record the attempt before it stops.
 */
export async function waitForHead(
  target: string,
  deps: {
    readHead: () => Promise<string>;
    onError?: (error: unknown) => void;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  },
  { timeoutMs = 20 * 60_000, intervalMs = 5_000 } = {},
): Promise<HeadWaitResult> {
  const deadline = deps.now() + timeoutMs;
  const seen: string[] = [];
  let lastError: unknown;
  let polls = 0;
  for (;;) {
    polls++;
    try {
      const head = await deps.readHead();
      if (seen.at(-1) !== head) seen.push(head);
      if (sameCommit(head, target)) return { state: "reached", head, polls, seen };
      // The first head seen may be the stale one; a second, different one is a new push.
      if (seen.length > 1) return { state: "moved", head, polls, seen };
    } catch (error) {
      lastError = error;
      deps.onError?.(error);
    }
    if (deps.now() + intervalMs > deadline) {
      if (!seen.length) {
        const error = lastError instanceof Error ? lastError.message : String(lastError);
        return { state: "failed", head: null, polls, seen: [], error };
      }
      return { state: "timeout", head: seen.at(-1) as string, polls, seen };
    }
    await deps.sleep(intervalMs);
  }
}

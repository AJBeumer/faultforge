/**
 * The polling behind `review:wait`: waiting for the PR head to become a commit, and for Qodo's review of
 * it to finish. Every read is passed in, so the waits run without a network or a clock in the tests.
 */
import { type QodoReview, reviewState } from "../qodo/qodo-review.ts";

export interface WaitDeps {
  fetchReview: () => Promise<QodoReview>;
  onPoll?: () => Promise<void>;
  /** A failed poll doesn't end the wait; it goes on until the deadline. */
  onError?: (error: unknown) => void;
  /**
   * When given, a finished review counts only if the head is still `headSha`: someone may have pushed
   * again while Qodo was reviewing.
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
 * A finished review is reported only once its comments were saved after it finished. At the deadline, the
 * last error is thrown if no poll succeeded or the final save never did.
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
      head: string;
      polls: number;
      seen: string[];
    }
  | { state: "failed"; head: null; polls: number; seen: []; error: string };

/** `target` may be a prefix of at least 7 characters. */
export function sameCommit(head: string, target: string): boolean {
  return target.length >= 7 && head.toLowerCase().startsWith(target.toLowerCase());
}

/**
 * Right after a push GitHub can show the previous head for a moment, and its finished review would pass
 * for the answer. That first head is waited out; any other head means someone pushed again. If no read
 * succeeds, the result is "failed", so the caller can record the attempt before it stops.
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

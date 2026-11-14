/**
 * What a tick puts right before it picks a ticket, so an interrupted run never leaves state only the owner
 * would notice (#197). Split from factory-tick.ts, which may not grow (CLAUDE.md, module size rule).
 *
 * A ticket labelled `agent-working` when a tick starts has no live run: the tick holds the run lock (or, in
 * CI, the workflow's one-at-a-time group), so whatever run claimed it stopped without reporting: its job was
 * cancelled, it hit the job's time limit, or the machine restarted. It is moved to `agent-needs-help` with a
 * comment, so it shows up on the owner's list instead of looking busy for ever.
 *
 * The two ways to run the factory (Actions, or the scheduled task on the owner's machine) don't share a
 * lock, so a tick in one can't tell whether the other's run is still alive. The claim comment says which way
 * claimed the ticket (`claimMarker`), and recovery leaves alone a ticket the other way claimed (AUD-M19):
 * that one is the other's to recover. A ticket with no claim mark (claimed before the mark existed) is
 * recovered as before.
 */
import { claimModeOf } from "./factory-comments.ts";
import type { RunMode } from "./factory-workspace.ts";

/** The labels the runner uses, repeated here so this module needs nothing from the runner. */
const WORKING = "agent-working";
const READY = "ready-for-agent";
const HELP = "agent-needs-help";
const DONE = "agent-done";

export interface RecoveryDeps {
  labelled(github: string, label: string): { number: number; title: string }[];
  relabel(
    github: string,
    number: number,
    remove: string[],
    add: string[],
  ): { removeFailed: unknown; addFailed: unknown };
  comment(github: string, number: number, body: string): void;
  /** Which way of running claimed the ticket, from the runner's own comments; absent in older fakes. */
  claimMode?(github: string, number: number): RunMode | null;
  /** This tick's own way of running; with `claimMode`, a ticket the other way claimed is left alone. */
  mode?: RunMode;
}

/** The comment a stranded ticket gets. Plain words only: it may be posted on a reviewed repo. */
export const STRANDED_COMMENT =
  "The scheduled agent run working on this ticket stopped without reporting: its job was cancelled or timed out, or the machine restarted. Nothing is running on it now, so it is marked as needing help. Look at the run's log before adding `ready-for-agent` again.";

/**
 * Moves every `agent-working` ticket in `repos` to `agent-needs-help` with a comment. Returns what it did, for
 * the run log. A ticket whose step fails is reported and left for the next tick; it never stops this one.
 *
 * The steps run in the order that leaves a ticket findable after any one of them fails (Qodo on PR 211):
 * the comment first, then `agent-needs-help` is added, and only then is `agent-working` removed. A failure
 * before the removal leaves `agent-working` on, so the next tick tries again. A ticket that already carries
 * `agent-needs-help` was commented on before and only lost its removal, so only the removal is retried and
 * no second comment is posted. Neither is one that already carries `agent-done`: its run finished and was
 * labelled (the new label goes on before the old comes off), and only lost its removal (Qodo on PR 262).
 */
export function recoverStranded(
  repos: { github: string }[],
  deps: RecoveryDeps,
): { recovered: string[]; failed: string[]; otherMode?: string[] } {
  const recovered: string[] = [];
  const failed: string[] = [];
  const otherMode: string[] = [];
  for (const { github } of repos) {
    let stranded: { number: number }[];
    let helped: Set<number>;
    try {
      stranded = deps.labelled(github, WORKING);
      // A ticket that already shows a run's result only lost its last label removal.
      helped = new Set(
        stranded.length ? [HELP, DONE].flatMap((label) => deps.labelled(github, label).map((t) => t.number)) : [],
      );
    } catch (error) {
      failed.push(`${github}: couldn't list its tickets (${(error as Error).message})`);
      continue;
    }
    for (const { number } of stranded) {
      const ref = `${github}#${number}`;
      try {
        const claimedBy = deps.mode && deps.claimMode ? deps.claimMode(github, number) : null;
        if (claimedBy && claimedBy !== deps.mode) {
          otherMode.push(`${ref} (claimed by a ${claimedBy} run)`);
          continue;
        }
        if (!helped.has(number)) {
          deps.comment(github, number, STRANDED_COMMENT);
          const added = deps.relabel(github, number, [], [HELP]);
          if (added.addFailed) throw new Error(`couldn't add ${HELP}: ${String(added.addFailed)}`);
        }
        const removed = deps.relabel(github, number, [WORKING, READY], []);
        if (removed.removeFailed) throw new Error(`couldn't remove ${WORKING}: ${String(removed.removeFailed)}`);
        recovered.push(ref);
      } catch (error) {
        failed.push(`${ref}: ${(error as Error).message}`);
      }
    }
  }
  return { recovered, failed, ...(otherMode.length ? { otherMode } : {}) };
}

/** Reads the claim mode from the comments the repo owner posted (the runner's token is the owner's). */
export function claimModeFrom(comments: { body?: string | null; user?: { login?: string } | null }[], owner: string) {
  return claimModeOf(
    comments.filter((c) => c.user?.login?.toLowerCase() === owner.toLowerCase()).map((c) => c.body ?? ""),
  );
}

/**
 * True when a lock file's holder is gone: no pid, its process is gone, or the live pid is now another
 * process (`isSame` says it didn't start when the lock recorded: after a crash or restart the system hands
 * pids on). The holder itself keeps its lock however old it is and however long one of its steps takes
 * (AUD-M19): neither the lock's age nor its heartbeat's ever frees it, so two ticks never run at once.
 */
export function lockIsStale(
  held: { pid?: number; started?: string },
  isAlive: (pid: number) => boolean,
  isSame: (pid: number, started: string | undefined) => boolean,
): boolean {
  return !held.pid || !isAlive(held.pid) || !isSame(held.pid, held.started);
}

/**
 * True when `pid` names a running process. `EPERM` means it exists but belongs to someone else: alive.
 * Only "no such process" means it is gone.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

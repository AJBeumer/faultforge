/**
 * What a tick puts right before it picks a ticket, so an interrupted run never leaves state only the owner
 * would notice (#197). Split from factory-tick.ts, which may not grow (CLAUDE.md, module size rule).
 *
 * A ticket labelled `agent-working` when a tick starts has no live run: the tick holds the run lock (or, in
 * CI, the workflow's one-at-a-time group), so whatever run claimed it stopped without reporting: its job was
 * cancelled, it hit the job's time limit, or the machine restarted. It is moved to `agent-needs-help` with a
 * comment, so it shows up on the owner's list instead of looking busy for ever.
 *
 * Only one of the two ways to run the factory (Actions, or the scheduled task on the owner's machine) may
 * be switched on at a time: they don't share a lock, and this would take the other's live ticket for a
 * stranded one.
 */

/** The labels the runner uses, repeated here so this module needs nothing from the runner. */
const WORKING = "agent-working";
const READY = "ready-for-agent";
const HELP = "agent-needs-help";

export interface RecoveryDeps {
  labelled(github: string, label: string): { number: number; title: string }[];
  relabel(
    github: string,
    number: number,
    remove: string[],
    add: string[],
  ): { removeFailed: unknown; addFailed: unknown };
  comment(github: string, number: number, body: string): void;
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
 * no second comment is posted.
 */
export function recoverStranded(
  repos: { github: string }[],
  deps: RecoveryDeps,
): { recovered: string[]; failed: string[] } {
  const recovered: string[] = [];
  const failed: string[] = [];
  for (const { github } of repos) {
    let stranded: { number: number }[];
    let helped: Set<number>;
    try {
      stranded = deps.labelled(github, WORKING);
      helped = new Set(stranded.length ? deps.labelled(github, HELP).map((t) => t.number) : []);
    } catch (error) {
      failed.push(`${github}: couldn't list its tickets (${(error as Error).message})`);
      continue;
    }
    for (const { number } of stranded) {
      const ref = `${github}#${number}`;
      try {
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
  return { recovered, failed };
}

/**
 * True when a lock file's holder can't be running: no pid, its process is gone, or its last heartbeat
 * (`at`) is older than the machine's start (`bootMs`), so the pid now belongs to another program. A live
 * pid whose heartbeat is after the start keeps the lock however old it is (AUD-M19): an age limit once let
 * a tick take over a run that was still going. An `at` that can't be read proves nothing about a restart,
 * so a live pid keeps the lock then too.
 */
export function lockIsStale(
  held: { pid?: number; at?: string },
  isAlive: (pid: number) => boolean,
  bootMs: number,
): boolean {
  if (!held.pid || !isAlive(held.pid)) return true;
  const at = held.at ? Date.parse(held.at) : Number.NaN;
  return Number.isFinite(at) && at < bootMs;
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

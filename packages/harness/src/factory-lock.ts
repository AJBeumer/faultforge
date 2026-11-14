/**
 * The tick's lock file, so only one run happens at a time. Split from factory-tick.ts (#227).
 */
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockIsStale, pidAlive } from "./factory-recovery.ts";

export interface Lock {
  acquired: boolean;
  release(): void;
  /** Writes a new heartbeat time into a lock that is still this tick's. The tick also does it on a timer. */
  refresh(): void;
  note?: string;
}

/** How often a running tick refreshes its heartbeat, on a timer and at every step it logs. */
export const HEARTBEAT_MS = 60_000;

/**
 * How long a heartbeat may go unrefreshed before its holder is taken for gone. The timer can't fire while a
 * synchronous step runs, so this is well over the longest one: verifying a PR runs `review:wait` (10 minutes),
 * an install (10) and `revert:check` (25) back to back. Not a limit on the run: a live tick's heartbeat
 * moves on at every step, however long the run takes.
 */
export const STALE_HEARTBEAT_MS = 90 * 60_000;

const NOT_ACQUIRED = { acquired: false, release: () => {}, refresh: () => {} } as const;

/**
 * The tick's lock file in `dir`. It holds the tick's pid, a random token, when it was taken (`since`) and
 * when the tick last said it was alive (`at`, refreshed every `heartbeatMs` while the tick runs).
 *
 * Taking it fresh writes the whole content to a file of its own and hard-links it into place: the link is
 * created only if nothing is there yet, and it appears with its content, so a tick reading it at that
 * instant never sees an empty file (AUD-N10) and two ticks racing for an unheld lock can never both get it.
 *
 * A lock is taken over only when its holder can't be a running tick: its pid is dead, or its heartbeat has
 * not moved for `STALE_HEARTBEAT_MS`, so the pid now belongs to another program or the tick hung
 * (`lockIsStale`). A running tick keeps it however old the lock is (AUD-M19): the lock's age no longer
 * counts, only the heartbeat. The machine's uptime is no guide (Qodo on PR 262): a clock correction moves a
 * boot time computed from it, and Windows Fast Startup doesn't reset it.
 *
 * Taking over a stale one is not naturally atomic - removing the old file and writing the new one are two
 * steps - so it goes through `renameSync` instead of `rmSync`: moving a file away is exclusive on its
 * *source* path. Two ticks can both try to move the same stale lock out of the way, but only one rename can
 * succeed; the other's throws ENOENT and it reports losing the race, same as for a live holder. The rename's
 * result is checked against exactly the bytes read before deciding to act, and put back if they no longer
 * match, so a fresh lock another tick took in between is never taken by accident.
 */
export function acquireLock(
  dir: string,
  isAlive: (pid: number) => boolean = pidAlive,
  options: { nowMs?: number; heartbeatMs?: number; staleMs?: number } = {},
): Lock {
  const { nowMs = Date.now(), heartbeatMs = HEARTBEAT_MS, staleMs = STALE_HEARTBEAT_MS } = options;
  const file = join(dir, "factory.lock");
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const since = new Date().toISOString();
  const content = () => JSON.stringify({ pid: process.pid, since, at: new Date().toISOString(), token });
  /** Writes the lock's content to a file of its own first, so the lock path only ever holds a whole lock. */
  const staged = () => {
    const tmp = join(dir, `factory.lock.${token}.${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmp, content(), { flag: "wx" });
    return tmp;
  };
  const take = () => {
    const tmp = staged();
    try {
      linkSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  };
  const ours = () => {
    try {
      return JSON.parse(readFileSync(file, "utf8")).token === token;
    } catch {
      return false;
    }
  };
  const refresh = () => {
    if (!ours()) return;
    const tmp = staged();
    try {
      renameSync(tmp, file);
    } catch {
      rmSync(tmp, { force: true });
    }
  };
  let timer: NodeJS.Timeout | undefined;
  // Releases only a lock that is still this tick's: one taken over meanwhile belongs to the tick that took it.
  const release = () => {
    if (timer) clearInterval(timer);
    if (ours()) rmSync(file, { force: true });
  };
  const won = (note?: string): Lock => {
    timer = setInterval(() => {
      try {
        refresh();
      } catch {
        // A missed heartbeat is tried again on the next one; a live pid keeps the lock anyway.
      }
    }, heartbeatMs);
    timer.unref();
    return { acquired: true, release, refresh, ...(note ? { note } : {}) };
  };
  try {
    take();
    return won();
  } catch {
    // Fallen through: something is already at `file`, live or stale.
  }
  let heldText = "";
  let held: { pid?: number; at?: string; since?: string } = {};
  try {
    heldText = readFileSync(file, "utf8");
    held = JSON.parse(heldText);
  } catch {
    // An unreadable lock has no pid, so it is stale below; heldText stays "" and won't match anything real.
  }
  if (!lockIsStale(held, isAlive, nowMs, staleMs))
    return { ...NOT_ACQUIRED, note: `pid ${held.pid} since ${held.since ?? held.at}, last heartbeat ${held.at}` };
  const lost = { ...NOT_ACQUIRED, note: "lost the race to take over a stale lock" };
  const graveyard = join(dir, `factory.lock.stale.${process.pid}.${Math.random().toString(36).slice(2)}`);
  try {
    renameSync(file, graveyard);
  } catch {
    return lost;
  }
  let isolatedText: string | null = null;
  try {
    isolatedText = readFileSync(graveyard, "utf8");
  } catch {
    // Nothing else ever names this exact graveyard path; vanishing here would be stranger still.
  }
  if (isolatedText !== heldText) {
    try {
      renameSync(graveyard, file);
    } catch {
      // Already gone or replaced again since: nothing more to undo.
    }
    return lost;
  }
  rmSync(graveyard, { force: true });
  try {
    take();
  } catch {
    return lost;
  }
  const why =
    held.pid && isAlive(held.pid) ? "its heartbeat stopped, so that pid is no running tick" : "its pid is gone";
  return won(`took over a stale lock from pid ${held.pid ?? "?"} (${held.at ?? "unknown time"}): ${why}`);
}

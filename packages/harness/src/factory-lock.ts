/**
 * The tick's lock file, so only one run happens at a time. Split from factory-tick.ts (#227).
 */
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockIsStale, pidAlive } from "./factory-recovery.ts";

export interface Lock {
  acquired: boolean;
  release(): void;
  /** Writes a new heartbeat for a lock that is still this tick's. The tick also does it on a timer. Never throws. */
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

const random = () => Math.random().toString(36).slice(2);

/** The heartbeat file of the lock holder with `token`: only that holder ever writes it. */
export function beatFile(dir: string, token: string): string {
  return join(dir, `factory.lock.${token}.beat`);
}

/** The last heartbeat of the holder with `token`, or undefined when it has none or it can't be read. */
export function lastBeat(dir: string, token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    const at = JSON.parse(readFileSync(beatFile(dir, token), "utf8")).at;
    return typeof at === "string" ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The tick's lock file in `dir`. It holds the tick's pid, a random token and when it was taken (`since`),
 * and is never rewritten while held. The heartbeat lives in a file of the holder's own
 * (`factory.lock.<token>.beat`), refreshed every `heartbeatMs` and at every step the tick logs: no other tick
 * ever writes that path, so a heartbeat can never land on a lock that has changed hands (Qodo on PR 262).
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
 * Taking over a stale one, and releasing one's own, go through `renameSync`, which is exclusive on its
 * *source* path: two ticks can't both move the same lock away. The moved file is then checked against what
 * was expected (the exact stale bytes read, or this tick's token). When it isn't that, it is put back with
 * `linkSync`, which never replaces a lock another tick took in between: nothing here ever overwrites the lock
 * path.
 */
export function acquireLock(
  dir: string,
  isAlive: (pid: number) => boolean = pidAlive,
  options: { nowMs?: number; heartbeatMs?: number; staleMs?: number } = {},
): Lock {
  const { nowMs = Date.now(), heartbeatMs = HEARTBEAT_MS, staleMs = STALE_HEARTBEAT_MS } = options;
  const file = join(dir, "factory.lock");
  const token = `${process.pid}-${random()}`;
  const since = new Date().toISOString();
  const beat = beatFile(dir, token);
  const take = () => {
    const tmp = join(dir, `factory.lock.${token}.${random()}.tmp`);
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, since, at: since, token }), { flag: "wx" });
    try {
      linkSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  };
  /** Moves the lock at `file` aside; keeps it there only if `wanted` says it's the one meant, else puts it back. */
  const moveAside = (wanted: (text: string) => boolean): string | null => {
    const aside = join(dir, `factory.lock.aside.${process.pid}.${random()}`);
    try {
      renameSync(file, aside);
    } catch {
      return null;
    }
    let text = "";
    try {
      text = readFileSync(aside, "utf8");
    } catch {
      // Nothing else ever names this exact path; an unreadable one is not the one wanted.
    }
    if (wanted(text)) return aside;
    try {
      linkSync(aside, file);
    } catch {
      // Another lock took the empty path in between: that one stands, and this one was never ours to keep.
    }
    rmSync(aside, { force: true });
    return null;
  };
  const refresh = () => {
    try {
      const tmp = `${beat}.${random()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString() }));
      renameSync(tmp, beat);
    } catch {
      // A missed heartbeat is tried again on the next step or timer; a run is never stopped by one.
    }
  };
  let timer: NodeJS.Timeout | undefined;
  // Releases only a lock that is still this tick's: one taken over meanwhile belongs to the tick that took it.
  const release = () => {
    if (timer) clearInterval(timer);
    const aside = moveAside((text) => {
      try {
        return JSON.parse(text).token === token;
      } catch {
        return false;
      }
    });
    if (aside) rmSync(aside, { force: true });
    rmSync(beat, { force: true });
  };
  const won = (note?: string): Lock => {
    refresh();
    timer = setInterval(refresh, heartbeatMs);
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
  let held: { pid?: number; at?: string; since?: string; token?: string } = {};
  try {
    heldText = readFileSync(file, "utf8");
    held = JSON.parse(heldText);
  } catch {
    // An unreadable lock has no pid, so it is stale below; heldText stays "" and won't match anything real.
  }
  const at = lastBeat(dir, held.token) ?? held.at;
  if (!lockIsStale({ pid: held.pid, at }, isAlive, nowMs, staleMs))
    return { ...NOT_ACQUIRED, note: `pid ${held.pid} since ${held.since ?? held.at}, last heartbeat ${at}` };
  const lost = { ...NOT_ACQUIRED, note: "lost the race to take over a stale lock" };
  const graveyard = moveAside((text) => text === heldText);
  if (!graveyard) return lost;
  rmSync(graveyard, { force: true });
  if (held.token) rmSync(beatFile(dir, held.token), { force: true });
  try {
    take();
  } catch {
    return lost;
  }
  const why =
    held.pid && isAlive(held.pid) ? "its heartbeat stopped, so that pid is no running tick" : "its pid is gone";
  return won(`took over a stale lock from pid ${held.pid ?? "?"} (${at ?? "unknown time"}): ${why}`);
}

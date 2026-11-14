/**
 * The tick's lock file, so only one run happens at a time. Split from factory-tick.ts (#227).
 */
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { killTree } from "./factory-kill.ts";
import { ownStartId, sameProcess } from "./factory-process.ts";
import { lockIsStale, pidAlive } from "./factory-recovery.ts";

export interface Lock {
  acquired: boolean;
  release(): void;
  /** Writes a new heartbeat for a lock that is still this tick's. The tick also does it on a timer. Never throws. */
  refresh(): void;
  /** Records the agent's pid and start with the heartbeat, so a tick that takes over after this runner was
   * killed can end the agent it left behind (AUD-M19). */
  recordAgent(pid: number, started?: string): void;
  note?: string;
}

/** How often a running tick refreshes its heartbeat, on a timer and at every step it logs. */
export const HEARTBEAT_MS = 60_000;

const NOT_ACQUIRED = { acquired: false, release: () => {}, refresh: () => {}, recordAgent: () => {} } as const;

const random = () => Math.random().toString(36).slice(2);

/** The heartbeat file of the lock holder with `token`: only that holder ever writes it. */
export function beatFile(dir: string, token: string): string {
  return join(dir, `factory.lock.${token}.beat`);
}

/** The last heartbeat of the holder with `token`, or undefined when it has none or it can't be read. */
export function lastBeat(dir: string, token: string | undefined): string | undefined {
  return readBeat(dir, token).at;
}

/** The holder's heartbeat file: its last beat, and its agent's pid and start while one runs. */
function readBeat(dir: string, token: string | undefined): { at?: string; agentPid?: number; agentStarted?: string } {
  if (!token) return {};
  try {
    const beat = JSON.parse(readFileSync(beatFile(dir, token), "utf8"));
    return {
      ...(typeof beat.at === "string" ? { at: beat.at } : {}),
      ...(Number.isInteger(beat.agentPid) ? { agentPid: beat.agentPid } : {}),
      ...(typeof beat.agentStarted === "string" ? { agentStarted: beat.agentStarted } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * The tick's lock file in `dir`. It holds the tick's pid, a random token and when it was taken (`since`),
 * and is never rewritten while held. The tick's heartbeat lives in a file of its own
 * (`factory.lock.<token>.beat`), refreshed every `heartbeatMs` and at every step the tick logs; no other tick
 * ever writes that path. The heartbeat shows a waiting tick, and the owner, when the holder last did
 * something; it never frees the lock.
 *
 * Taking it fresh writes the whole content to a file of its own and hard-links it into place: the link is
 * created only if nothing is there yet, and it appears with its content, so a tick reading it at that
 * instant never sees an empty file (AUD-N10) and two ticks racing for an unheld lock can never both get it.
 *
 * A lock is taken over only when its holder is gone: its pid is dead, or the live pid is another process
 * that started later, so the system handed it on after a crash or restart (`lockIsStale`; the lock records
 * when its holder started, `factory-process.ts`). The holder itself keeps its lock
 * however old it is and however long one of its steps takes (AUD-M19): neither the lock's age nor the
 * heartbeat's frees it (Qodo on PR 262: a heartbeat limit let a slow but live tick lose its lock). The
 * machine's uptime is no guide either: a clock correction moves a boot time computed from it, and Windows
 * Fast Startup doesn't reset it.
 *
 * Since a live holder is never taken over, a holder's release can't race a takeover: it removes the lock only
 * when the token in it is its own. Taking over a stale one goes through `renameSync`, which is exclusive on
 * its *source* path, so two ticks can't both move the same stale lock away; the moved file is checked against
 * the exact bytes read, and anything else is put back with `linkSync`, which never replaces a lock another
 * tick took in between.
 *
 * The heartbeat also records the agent's pid and start while one runs (`recordAgent`). A runner killed
 * outright leaves its agent running with no time limit; the tick that takes the stale lock over kills that
 * agent's tree first (`killAgent`), before it recovers the ticket (AUD-M19). Only when that pid is alive and
 * still the process that started then (`isSame`): once the agent ended, its pid may belong to another.
 */
export function acquireLock(
  dir: string,
  isAlive: (pid: number) => boolean = pidAlive,
  options: {
    heartbeatMs?: number;
    isSame?: (pid: number, started: string | undefined) => boolean;
    killAgent?: (pid: number) => void;
  } = {},
): Lock {
  const {
    heartbeatMs = HEARTBEAT_MS,
    isSame = (pid, started) => sameProcess(pid, started),
    killAgent = killTree,
  } = options;
  let agent: { agentPid: number; agentStarted?: string } | undefined;
  const file = join(dir, "factory.lock");
  const token = `${process.pid}-${random()}`;
  const since = new Date().toISOString();
  const beat = beatFile(dir, token);
  // Read once, the same way a later tick reads it to check this lock's holder (factory-process.ts).
  const ownStart = ownStartId() ?? undefined;
  const take = () => {
    const tmp = join(dir, `factory.lock.${token}.${random()}.tmp`);
    const lock = { pid: process.pid, started: ownStart, since, at: since, token };
    writeFileSync(tmp, JSON.stringify(lock), { flag: "wx" });
    try {
      linkSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  };
  const refresh = () => {
    try {
      const tmp = `${beat}.${random()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), ...agent }));
      renameSync(tmp, beat);
    } catch {
      // A missed heartbeat is tried again on the next step or timer; a run is never stopped by one.
    }
  };
  let timer: NodeJS.Timeout | undefined;
  // Releases only a lock that is still this tick's: one taken over (its holder was gone) belongs to the
  // tick that took it.
  const release = () => {
    if (timer) clearInterval(timer);
    try {
      if (JSON.parse(readFileSync(file, "utf8")).token === token) rmSync(file, { force: true });
    } catch {
      // gone already, or unreadable: nothing of ours to remove
    }
    try {
      rmSync(beat, { force: true });
    } catch {
      // A heartbeat file left behind belongs to no lock: harmless, and never worth failing a tick over.
    }
  };
  const won = (note?: string): Lock => {
    refresh();
    timer = setInterval(refresh, heartbeatMs);
    timer.unref();
    const recordAgent = (pid: number, started?: string) => {
      agent = { agentPid: pid, ...(started ? { agentStarted: started } : {}) };
      refresh();
    };
    return { acquired: true, release, refresh, recordAgent, ...(note ? { note } : {}) };
  };
  try {
    take();
    return won();
  } catch {
    // Fallen through: something is already at `file`, live or stale.
  }
  let heldText = "";
  let held: { pid?: number; started?: string; at?: string; since?: string; token?: string } = {};
  try {
    heldText = readFileSync(file, "utf8");
    held = JSON.parse(heldText);
  } catch {
    // An unreadable lock has no pid, so it is stale below; heldText stays "" and won't match anything real.
  }
  const beatNow = readBeat(dir, held.token);
  const at = beatNow.at ?? held.at;
  if (!lockIsStale(held, isAlive, isSame))
    return { ...NOT_ACQUIRED, note: `pid ${held.pid} since ${held.since ?? held.at}, last heartbeat ${at}` };
  const lost = { ...NOT_ACQUIRED, note: "lost the race to take over a stale lock" };
  const graveyard = join(dir, `factory.lock.stale.${process.pid}.${random()}`);
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
      linkSync(graveyard, file);
    } catch {
      // Another lock took the empty path in between: that one stands.
    }
    rmSync(graveyard, { force: true });
    return lost;
  }
  rmSync(graveyard, { force: true });
  if (held.token) rmSync(beatFile(dir, held.token), { force: true });
  try {
    take();
  } catch {
    return lost;
  }
  const why = held.pid && isAlive(held.pid) ? "that pid is now another process" : "its pid is gone";
  let ended = "";
  const { agentPid, agentStarted } = beatNow;
  if (agentPid && agentStarted && isAlive(agentPid) && isSame(agentPid, agentStarted)) {
    try {
      killAgent(agentPid);
      ended = `; ended its agent, pid ${agentPid}`;
    } catch (error) {
      ended = `; couldn't end its agent, pid ${agentPid}: ${(error as Error).message}`;
    }
  }
  return won(`took over a stale lock from pid ${held.pid ?? "?"} (${at ?? "unknown time"}): ${why}${ended}`);
}

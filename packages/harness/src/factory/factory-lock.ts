/**
 * The tick's lock file, so only one run happens at a time.
 */
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { killTree } from "./factory-kill.ts";
import { ownStartId, processStartId, sameProcess } from "./factory-process.ts";
import { lockIsStale, pidAlive } from "./factory-recovery.ts";

export interface Lock {
  acquired: boolean;
  release(): void;
  /** Writes a new heartbeat for a lock that is still this tick's. The tick also does it on a timer. Never throws. */
  refresh(): void;
  /** Records the agent's pid and start with the heartbeat, so a tick that takes over after this runner was
   * killed can end the agent it left behind. */
  recordAgent(pid: number | null, started?: string): void;
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
export function readBeat(
  dir: string,
  token: string | undefined,
): { at?: string; agentPid?: number; agentStarted?: string } {
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
 * Takes the tick's lock in `dir`, hard-linked into place so it appears whole and two ticks can't both take it.
 * A lock changes hands only when its holder is gone (`lockIsStale`): a slow but live holder keeps it.
 */
export function acquireLock(
  dir: string,
  isAlive: (pid: number) => boolean = pidAlive,
  options: {
    heartbeatMs?: number;
    isSame?: (pid: number, started: string | undefined) => boolean;
    killAgent?: (pid: number) => void;
    /** Reads a live process's start id now (`processStartId`), to tell the recorded agent from a reused pid. */
    startIdOf?: (pid: number) => string | null;
  } = {},
): Lock {
  const {
    heartbeatMs = HEARTBEAT_MS,
    isSame = (pid, started) => sameProcess(pid, started),
    killAgent = killTree,
    startIdOf = processStartId,
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
  // Releases only a lock that is still this tick's: one taken over belongs to the tick that took it.
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
    const recordAgent = (pid: number | null, started?: string) => {
      agent = pid ? { agentPid: pid, ...(started ? { agentStarted: started } : {}) } : undefined;
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
  // The gone runner's agent is ended before the lock changes hands, so no second run starts beside it. Killed
  // only on proof the pid is still the agent; when that can't be told, nothing is killed and the lock stays.
  let ended = "";
  const { agentPid, agentStarted } = beatNow;
  if (agentPid && isAlive(agentPid)) {
    const now = startIdOf(agentPid);
    const keep = (why: string) => ({
      ...NOT_ACQUIRED,
      note: `the stale lock's agent, pid ${agentPid}, ${why}, so the lock stays`,
    });
    if (!agentStarted || now === null) return keep("may still be running and can't be told from another process");
    if (now === agentStarted) {
      try {
        killAgent(agentPid);
        ended = `; ended its agent, pid ${agentPid}`;
      } catch (error) {
        return keep(`couldn't be ended (${(error as Error).message})`);
      }
    }
  }
  const lost = { ...NOT_ACQUIRED, note: "lost the race to take over a stale lock" };
  // Only one tick can rename the stale lock away; a moved file that isn't the one read goes back.
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
  return won(`took over a stale lock from pid ${held.pid ?? "?"} (${at ?? "unknown time"}): ${why}${ended}`);
}

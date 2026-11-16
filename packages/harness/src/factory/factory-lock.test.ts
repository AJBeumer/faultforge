import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, beatFile, lastBeat } from "./factory-lock.ts";
import { ownStartId, sameProcess } from "./factory-process.ts";
import { lockIsStale, pidAlive } from "./factory-recovery.ts";

describe("acquireLock (#107)", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "ff-lock-"));

  it("acquires a fresh lock, and release lets it be acquired again", () => {
    const dir = tmp();
    const a = acquireLock(dir);
    expect(a.acquired).toBe(true);
    expect(a.note).toBeUndefined();
    a.release();
    expect(acquireLock(dir).acquired).toBe(true);
  });

  it("is busy when a live process holds the lock", () => {
    const dir = tmp();
    expect(acquireLock(dir).acquired).toBe(true);
    const b = acquireLock(dir, () => true, { isSame: () => true });
    expect(b.acquired).toBe(false);
    expect(b.note).toMatch(/pid \d+ since/);
  });

  it("takes over a stale lock whose pid is dead", () => {
    const dir = tmp();
    expect(acquireLock(dir).acquired).toBe(true);
    const b = acquireLock(dir, () => false);
    expect(b.acquired).toBe(true);
    expect(b.note).toMatch(/took over a stale lock/);
    expect(b.note).not.toMatch(/still running/);
  });

  it("the second of two ticks that both try to take over the same stale lock reports busy, never both wins (Qodo on PR 123)", () => {
    const dir = tmp();
    const file = join(dir, "factory.lock");
    writeFileSync(file, JSON.stringify({ pid: 999999, at: "2026-11-09T00:00:00Z" }));
    // Simulate a second tick's own renameSync, of the exact same stale lock, winning the race: by the
    // time this tick's own renameSync runs, there is nothing left at `file` to rename away.
    const raced = () => {
      rmSync(file, { force: true });
      return false;
    };
    const result = acquireLock(dir, raced);
    expect(result.acquired).toBe(false);
    expect(result.note).toMatch(/lost the race/);
  });

  it("leaves no graveyard file behind after taking over a stale lock", () => {
    const dir = tmp();
    writeFileSync(join(dir, "factory.lock"), JSON.stringify({ pid: 999999, at: "2026-11-09T00:00:00Z" }));
    expect(acquireLock(dir, () => false).acquired).toBe(true);
    expect(readdirSync(dir).filter((n) => !n.endsWith(".beat"))).toEqual(["factory.lock"]);
  });

  it("never steals a lock another tick already took over in between this tick's read and its rename (Qodo on PR 123)", () => {
    const dir = tmp();
    const file = join(dir, "factory.lock");
    writeFileSync(file, JSON.stringify({ pid: 999999, at: "2026-11-09T00:00:00Z" }));
    // Simulate another tick completing its own full stale takeover - moving the same stale lock away and
    // taking a fresh one of its own - in the gap between this tick reading the lock as stale and acting
    // on that read.
    const racedToOwnFreshLock = () => {
      writeFileSync(file, JSON.stringify({ pid: 777777, at: "2026-11-10T00:00:00Z" }), { flag: "w" });
      return false;
    };
    const result = acquireLock(dir, racedToOwnFreshLock);
    expect(result.acquired).toBe(false);
    expect(result.note).toMatch(/lost the race/);
    // The other tick's fresh lock must survive untouched, not be replaced by this tick's own.
    expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(777777);
    expect(readdirSync(dir)).toEqual(["factory.lock"]);
  });
});

describe("acquireLock: a live tick keeps its lock however old; only a gone holder frees it (AUD-M19)", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "ff-lock-live-"));
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  const holder = { isSame: () => true };

  it("never takes over a live tick's lock taken days ago, even with its heartbeat days old too", () => {
    const d = dir();
    writeFileSync(
      join(d, "factory.lock"),
      JSON.stringify({ pid: 12345, since: daysAgo(4), at: daysAgo(4), token: "t" }),
    );
    writeFileSync(beatFile(d, "t"), JSON.stringify({ at: daysAgo(3) }));
    // The old rule took over any lock older than the run's limit plus an hour; a heartbeat limit would
    // take over a slow step's (Qodo on PR 262).
    const result = acquireLock(d, () => true, holder);
    expect(result.acquired).toBe(false);
    expect(result.note).toMatch(/pid 12345 since .*last heartbeat/);
  });

  it("takes over a lock whose live pid is another process now: the system handed it on", () => {
    const d = dir();
    writeFileSync(join(d, "factory.lock"), JSON.stringify({ pid: 12345, since: daysAgo(1), token: "t" }));
    const taken = acquireLock(d, () => true, { isSame: () => false });
    expect(taken.acquired).toBe(true);
    expect(taken.note).toMatch(/that pid is now another process/);
    taken.release();
  });

  it("decides staleness from the pid alone: dead, or another process now", () => {
    expect(
      lockIsStale(
        { pid: 1 },
        () => true,
        () => true,
      ),
    ).toBe(false);
    expect(
      lockIsStale(
        { pid: 1 },
        () => false,
        () => true,
      ),
    ).toBe(true);
    expect(
      lockIsStale(
        { pid: 1 },
        () => true,
        () => false,
      ),
    ).toBe(true);
    expect(
      lockIsStale(
        {},
        () => true,
        () => true,
      ),
    ).toBe(true);
  });

  it("knows the holder by the start id the system keeps, and keeps the lock when that can't be read", () => {
    expect(sameProcess(1, "ticks:900", () => "ticks:900")).toBe(true);
    expect(sameProcess(1, "ticks:900", () => "ticks:7311")).toBe(false);
    expect(sameProcess(1, "ticks:900", () => null)).toBe(true);
    // A lock written before the start was recorded.
    expect(sameProcess(1, undefined, () => "ticks:7311")).toBe(true);
  });

  it("records its holder's start id, so a later tick can tell", () => {
    const d = dir();
    const lock = acquireLock(d);
    const held = JSON.parse(readFileSync(join(d, "factory.lock"), "utf8"));
    expect(held.started).toBe(ownStartId());
    lock.release();
  });

  it("reads a permission error as a live process, and only 'no such process' as gone", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2_147_483_646)).toBe(false);
  });
});

describe("acquireLock: the heartbeat (AUD-M19)", () => {
  const tokenIn = (d: string) => JSON.parse(readFileSync(join(d, "factory.lock"), "utf8")).token as string;
  const beatIn = (d: string) => Date.parse(lastBeat(d, tokenIn(d)) ?? "");
  const nextClockTick = async (after: number) => {
    // Windows can step the clock in 16 ms increments.
    while (Date.now() <= after) await new Promise((r) => setTimeout(r, 5));
  };

  it("refresh writes a newer heartbeat to the holder's own file, and never touches the lock itself", async () => {
    const d = mkdtempSync(join(tmpdir(), "ff-lock-beat-"));
    const file = join(d, "factory.lock");
    const lock = acquireLock(d);
    const lockText = readFileSync(file, "utf8");
    const first = beatIn(d);
    await nextClockTick(first);
    lock.refresh();
    expect(beatIn(d)).toBeGreaterThan(first);
    expect(readFileSync(file, "utf8")).toBe(lockText);
    lock.release();
  });

  it("a heartbeat after the lock changed hands lands on the old holder's own file, never on the new lock (Qodo on PR 262)", () => {
    const d = mkdtempSync(join(tmpdir(), "ff-lock-hands-"));
    const file = join(d, "factory.lock");
    const old = acquireLock(d);
    // A tick that took it over: the lock path now holds its lock.
    writeFileSync(file, JSON.stringify({ pid: 777777, since: "2026-11-10T00:00:00Z", token: "other" }));
    old.refresh();
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe("other");
    old.release();
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe("other");
  });

  it("a heartbeat that can't be written never throws", () => {
    const d = mkdtempSync(join(tmpdir(), "ff-lock-nowrite-"));
    const lock = acquireLock(d);
    rmSync(d, { recursive: true, force: true });
    expect(() => lock.refresh()).not.toThrow();
    expect(() => lock.release()).not.toThrow();
  });

  it("a running tick refreshes it on a timer, and stops when it releases", async () => {
    const d = mkdtempSync(join(tmpdir(), "ff-lock-timer-"));
    const file = join(d, "factory.lock");
    const lock = acquireLock(d, () => true, { heartbeatMs: 20, isSame: () => true });
    const token = tokenIn(d);
    const first = beatIn(d);
    // Waits for a beat, up to two seconds: a busy machine can delay a 20 ms timer, never skip it.
    for (let waited = 0; waited < 2000 && beatIn(d) <= first; waited += 20) await new Promise((r) => setTimeout(r, 20));
    expect(beatIn(d)).toBeGreaterThan(first);
    lock.release();
    expect(existsSync(file)).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(existsSync(file)).toBe(false);
    expect(existsSync(beatFile(d, token))).toBe(false);
  });

  it("a fresh heartbeat keeps a lock whose own time is old", () => {
    const d = mkdtempSync(join(tmpdir(), "ff-lock-fresh-"));
    writeFileSync(join(d, "factory.lock"), JSON.stringify({ pid: 12345, at: "2026-11-01T00:00:00Z", token: "t1" }));
    writeFileSync(beatFile(d, "t1"), JSON.stringify({ at: new Date().toISOString() }));
    expect(acquireLock(d, () => true, { isSame: () => true }).acquired).toBe(false);
  });

  it("never leaves a lock file without content: it appears whole or not at all", () => {
    const d = mkdtempSync(join(tmpdir(), "ff-lock-whole-"));
    const lock = acquireLock(d);
    expect(JSON.parse(readFileSync(join(d, "factory.lock"), "utf8")).pid).toBe(process.pid);
    expect(readdirSync(d).filter((n) => !n.endsWith(".beat"))).toEqual(["factory.lock"]);
    lock.release();
    expect(readdirSync(d)).toEqual([]);
  });
});

describe("acquireLock: the release belongs to this run (Qodo on PR 211)", () => {
  it("leaves a lock another tick took over when the first one releases", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-lock-own-"));
    const first = acquireLock(dir);
    const second = acquireLock(dir, () => false);
    expect(second.acquired).toBe(true);
    first.release();
    expect(existsSync(join(dir, "factory.lock"))).toBe(true);
    second.release();
    expect(existsSync(join(dir, "factory.lock"))).toBe(false);
  });
});

describe("acquireLock: a runner killed outright leaves no agent behind (AUD-M19)", () => {
  const recent = () => new Date(Date.now() - 5 * 60_000).toISOString();
  const AGENT_START = "ticks:52000";
  /** A lock held by a runner with `held.pid`, whose heartbeat records its agent's pid and start. */
  const lockWith = (held: { pid: number; agentPid: number; agentStarted?: string }) => {
    const d = mkdtempSync(join(tmpdir(), "ff-lock-agent-"));
    writeFileSync(join(d, "factory.lock"), JSON.stringify({ pid: held.pid, since: recent(), token: "t1" }));
    writeFileSync(
      beatFile(d, "t1"),
      JSON.stringify({ at: recent(), agentPid: held.agentPid, agentStarted: held.agentStarted }),
    );
    return d;
  };
  const beatOf = (d: string) => {
    const token = JSON.parse(readFileSync(join(d, "factory.lock"), "utf8")).token;
    return JSON.parse(readFileSync(beatFile(d, token), "utf8"));
  };
  /** The runner (pid 1111) is gone; the agent's pid (4242) is alive, and reads now as `startNow`. */
  const takeOver = (d: string, startNow: string | null, killed: number[], kill?: () => void) =>
    acquireLock(d, (pid) => pid === 4242, {
      startIdOf: () => startNow,
      killAgent: kill ?? ((pid) => killed.push(pid)),
    });

  it("records the agent's pid and start with the heartbeat while it runs, and forgets them when it ends", () => {
    const d = mkdtempSync(join(tmpdir(), "ff-lock-rec-"));
    const lock = acquireLock(d);
    lock.recordAgent(4242, AGENT_START);
    expect(beatOf(d)).toMatchObject({ agentPid: 4242, agentStarted: AGENT_START });
    lock.refresh();
    expect(beatOf(d)).toMatchObject({ agentPid: 4242, agentStarted: AGENT_START });
    lock.recordAgent(null);
    expect(beatOf(d).agentPid).toBeUndefined();
    lock.release();
  });

  it("kills the dead runner's agent tree before taking the lock over, when the pid is still that agent", () => {
    const killed: number[] = [];
    const lock = takeOver(lockWith({ pid: 1111, agentPid: 4242, agentStarted: AGENT_START }), AGENT_START, killed);
    expect(lock.acquired).toBe(true);
    expect(killed).toEqual([4242]);
    expect(lock.note).toMatch(/ended its agent, pid 4242/);
    lock.release();
  });

  it("kills nothing when the agent's pid is now another process, and takes the lock over", () => {
    const killed: number[] = [];
    const lock = takeOver(lockWith({ pid: 1111, agentPid: 4242, agentStarted: AGENT_START }), "ticks:9", killed);
    expect(lock.acquired).toBe(true);
    expect(killed).toEqual([]);
    lock.release();
  });

  it("kills nothing and keeps the lock when it can't tell whether the pid is the agent (Qodo on PR 268)", () => {
    const killed: number[] = [];
    const noStart = takeOver(lockWith({ pid: 1111, agentPid: 4242 }), AGENT_START, killed);
    const unreadable = takeOver(lockWith({ pid: 1111, agentPid: 4242, agentStarted: AGENT_START }), null, killed);
    for (const lock of [noStart, unreadable]) {
      expect(lock.acquired).toBe(false);
      expect(lock.note).toMatch(/may still be running and can't be told from another process, so the lock stays/);
    }
    expect(killed).toEqual([]);
  });

  it("keeps the lock where it is when the kill fails (Qodo on PR 268)", () => {
    const d = lockWith({ pid: 1111, agentPid: 4242, agentStarted: AGENT_START });
    const lock = takeOver(d, AGENT_START, [], () => {
      throw new Error("access denied");
    });
    expect(lock.acquired).toBe(false);
    expect(lock.note).toMatch(/couldn't be ended \(access denied\), so the lock stays/);
    expect(JSON.parse(readFileSync(join(d, "factory.lock"), "utf8")).token).toBe("t1");
  });

  it("kills nothing when the agent is gone", () => {
    const killed: number[] = [];
    const d = lockWith({ pid: 1111, agentPid: 4242, agentStarted: AGENT_START });
    acquireLock(d, () => false, { startIdOf: () => AGENT_START, killAgent: (pid) => killed.push(pid) }).release();
    expect(killed).toEqual([]);
  });

  it("never kills the agent of a running tick", () => {
    const killed: number[] = [];
    const d = lockWith({ pid: 1111, agentPid: 4242, agentStarted: AGENT_START });
    const lock = acquireLock(d, () => true, {
      isSame: () => true,
      startIdOf: () => AGENT_START,
      killAgent: (pid) => killed.push(pid),
    });
    expect(lock.acquired).toBe(false);
    expect(killed).toEqual([]);
  });
});

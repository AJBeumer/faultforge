import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, beatFile, lastBeat } from "./factory-lock.ts";
import { isTickProcess, lockIsStale, pidAlive } from "./factory-recovery.ts";

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
    const b = acquireLock(dir, () => true, { isHolder: () => true });
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
  const holder = { isHolder: () => true };

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

  it("takes over a lock whose pid now runs another program: the system handed it on", () => {
    const d = dir();
    writeFileSync(join(d, "factory.lock"), JSON.stringify({ pid: 12345, since: daysAgo(1), token: "t" }));
    const taken = acquireLock(d, () => true, { isHolder: () => false });
    expect(taken.acquired).toBe(true);
    expect(taken.note).toMatch(/that pid now runs another program/);
    taken.release();
  });

  it("decides staleness from the pid alone: dead, or another program's", () => {
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

  it("knows a tick's process by its program, and keeps the lock when the name can't be read", () => {
    expect(isTickProcess(1, () => "node.exe")).toBe(true);
    expect(isTickProcess(1, () => "node")).toBe(true);
    expect(isTickProcess(1, () => "/usr/bin/node")).toBe(true);
    expect(isTickProcess(1, () => null)).toBe(true);
    expect(isTickProcess(1, () => "svchost.exe")).toBe(false);
    expect(isTickProcess(1, () => "nodemon")).toBe(false);
    // This test's own process is a Node process.
    expect(isTickProcess(process.pid)).toBe(true);
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
    const lock = acquireLock(d, () => true, { heartbeatMs: 20, isHolder: () => true });
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
    expect(acquireLock(d, () => true, { isHolder: () => true }).acquired).toBe(false);
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

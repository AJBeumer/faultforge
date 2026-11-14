import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock, HEARTBEAT_MS, STALE_HEARTBEAT_MS } from "./factory-lock.ts";
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
    const b = acquireLock(dir, () => true);
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
    expect(readdirSync(dir)).toEqual(["factory.lock"]);
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

describe("acquireLock: a running tick keeps its lock however old; a stopped heartbeat frees it (AUD-M19)", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "ff-lock-live-"));
  const NOW = Date.parse("2026-11-14T12:00:00.000Z");
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

  it("never takes over a live pid's lock taken days ago, while its heartbeat moves", () => {
    const d = dir();
    const held = { pid: 12345, since: "2026-11-10T01:00:00.000Z", at: minutesAgo(2) };
    writeFileSync(join(d, "factory.lock"), JSON.stringify(held));
    // The old rule took over any lock older than the run's limit plus an hour.
    const result = acquireLock(d, () => true, { nowMs: NOW });
    expect(result.acquired).toBe(false);
    expect(result.note).toMatch(/pid 12345 since 2026-11-10T01:00:00.000Z/);
  });

  it("keeps it through a long synchronous step: a heartbeat an hour old is still a running tick", () => {
    const d = dir();
    writeFileSync(join(d, "factory.lock"), JSON.stringify({ pid: 12345, at: minutesAgo(60) }));
    expect(acquireLock(d, () => true, { nowMs: NOW }).acquired).toBe(false);
  });

  it("takes over a live pid's lock whose heartbeat stopped: the pid is another program's, or the tick hung", () => {
    const d = dir();
    writeFileSync(
      join(d, "factory.lock"),
      JSON.stringify({ pid: 12345, at: minutesAgo(STALE_HEARTBEAT_MS / 60_000 + 1) }),
    );
    const taken = acquireLock(d, () => true, { nowMs: NOW });
    expect(taken.acquired).toBe(true);
    expect(taken.note).toMatch(/heartbeat stopped/);
    taken.release();
  });

  it("decides staleness from the pid and the heartbeat only", () => {
    const stale = STALE_HEARTBEAT_MS;
    expect(lockIsStale({ pid: 1, at: minutesAgo(5) }, () => true, NOW, stale)).toBe(false);
    expect(lockIsStale({ pid: 1, at: minutesAgo(5) }, () => false, NOW, stale)).toBe(true);
    expect(lockIsStale({ pid: 1, at: minutesAgo(91) }, () => true, NOW, stale)).toBe(true);
    expect(lockIsStale({ pid: 1, at: "not a date" }, () => true, NOW, stale)).toBe(true);
    expect(lockIsStale({}, () => true, NOW, stale)).toBe(true);
  });

  it("allows more than the longest synchronous step the heartbeat timer can't run through", () => {
    // review:wait (10 minutes), an install (10) and revert:check (25), back to back in the verify step.
    expect(STALE_HEARTBEAT_MS).toBeGreaterThan((10 + 10 + 25) * 60_000);
    expect(HEARTBEAT_MS).toBeLessThan(STALE_HEARTBEAT_MS / 10);
  });

  it("reads a permission error as a live process, and only 'no such process' as gone", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2_147_483_646)).toBe(false);
  });
});

describe("acquireLock: the heartbeat (AUD-M19)", () => {
  it("refresh writes a newer heartbeat with the same token, and only into a lock that is still this tick's", async () => {
    const d = mkdtempSync(join(tmpdir(), "ff-lock-beat-"));
    const file = join(d, "factory.lock");
    const lock = acquireLock(d);
    const first = JSON.parse(readFileSync(file, "utf8"));
    await new Promise((r) => setTimeout(r, 15));
    lock.refresh();
    const second = JSON.parse(readFileSync(file, "utf8"));
    expect(second.token).toBe(first.token);
    expect(second.since).toBe(first.since);
    expect(Date.parse(second.at)).toBeGreaterThan(Date.parse(first.at));
    // Someone else's lock now: refresh leaves it alone.
    writeFileSync(file, JSON.stringify({ pid: 777777, at: "2026-11-10T00:00:00Z", token: "other" }));
    lock.refresh();
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe("other");
    expect(readdirSync(d)).toEqual(["factory.lock"]);
  });

  it("a running tick refreshes it on a timer, and stops when it releases", async () => {
    const d = mkdtempSync(join(tmpdir(), "ff-lock-timer-"));
    const file = join(d, "factory.lock");
    const lock = acquireLock(d, () => true, { heartbeatMs: 20 });
    const first = Date.parse(JSON.parse(readFileSync(file, "utf8")).at);
    const heartbeat = () => Date.parse(JSON.parse(readFileSync(file, "utf8")).at);
    // Waits for a beat, up to two seconds: a busy machine can delay a 20 ms timer, never skip it.
    for (let waited = 0; waited < 2000 && heartbeat() <= first; waited += 20)
      await new Promise((r) => setTimeout(r, 20));
    expect(heartbeat()).toBeGreaterThan(first);
    lock.release();
    expect(existsSync(file)).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(existsSync(file)).toBe(false);
  });

  it("never leaves a lock file without content: it appears whole or not at all", () => {
    const d = mkdtempSync(join(tmpdir(), "ff-lock-whole-"));
    const lock = acquireLock(d);
    expect(JSON.parse(readFileSync(join(d, "factory.lock"), "utf8")).pid).toBe(process.pid);
    expect(readdirSync(d)).toEqual(["factory.lock"]);
    lock.release();
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

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireLock } from "./factory-lock.ts";
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

describe("acquireLock and pidAlive after a restart (#197)", () => {
  it("takes over a lock older than any run can last, even when its pid now names a live process", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-lock-old-"));
    writeFileSync(join(dir, "factory.lock"), JSON.stringify({ pid: 12345, at: "2026-11-01T00:00:00.000Z" }));
    expect(acquireLock(dir, () => true).acquired).toBe(true);
  });

  it("keeps a recent lock whose holder is alive", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-lock-new-"));
    writeFileSync(join(dir, "factory.lock"), JSON.stringify({ pid: 12345, at: new Date().toISOString() }));
    expect(acquireLock(dir, () => true).acquired).toBe(false);
  });

  it("reads a permission error as a live process, and only 'no such process' as gone", () => {
    expect(lockIsStale({ pid: 1, at: new Date().toISOString() }, () => true, Date.now(), 60_000)).toBe(false);
    expect(lockIsStale({ pid: 1, at: "not a date" }, () => true, Date.now(), 60_000)).toBe(true);
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2_147_483_646)).toBe(false);
  });
});

describe("acquireLock: the age limit and the release belong to this run (Qodo on PR 211)", () => {
  it("keeps a live lock younger than the age it is given, and takes over an older one", () => {
    const dir = mkdtempSync(join(tmpdir(), "ff-lock-age-"));
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    writeFileSync(join(dir, "factory.lock"), JSON.stringify({ pid: 12345, at: twoHoursAgo }));
    expect(acquireLock(dir, () => true, 3 * 3_600_000).acquired).toBe(false);
    const taken = acquireLock(dir, () => true, 1 * 3_600_000);
    expect(taken.acquired).toBe(true);
    // The tick logs this note: a holder still alive past every run's limit may be a hung agent (#226).
    expect(taken.note).toMatch(/a process with that pid is still running/);
  });

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

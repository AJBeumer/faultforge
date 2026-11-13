/**
 * The tick's lock file, so only one run happens at a time. Split from factory-tick.ts (#227).
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockIsStale, pidAlive } from "./factory-recovery.ts";

/**
 * The tick's lock file in `dir`. Taking it fresh is a single atomic `wx` write, so two ticks racing for
 * an unheld lock can never both get it.
 *
 * Taking over a *stale* one (its pid is dead) is not naturally atomic - removing the old file and writing
 * the new one are two steps - so it goes through `renameSync` instead of `rmSync`: moving a file away is
 * exclusive on its *source* path the same way `wx` is exclusive on a path that doesn't exist yet. Two
 * ticks can both try to move the same stale lock out of the way, but only one `renameSync` call can ever
 * succeed against that source path - the other's throws ENOENT, because by then there is nothing left
 * there to rename, and it reports losing the race, same as for a live holder.
 *
 * Reading the stale lock's own content and deciding it is stale are still two steps, so between them
 * another tick can have already moved it out of the way and taken a fresh lock of its own: this tick's
 * rename would then isolate that fresh lock by accident, not the stale one it read. The rename's result is
 * checked against exactly the bytes read before deciding to act, and restored if they no longer match,
 * rather than ever proceeding on a lock that turned out to belong to someone else. Only once that check
 * passes does the winner take the now-empty path for itself; if a third tick's own plain, unrelated `wx`
 * write lands in the instant between that and its own `take()`, that `take()` fails too, and it reports
 * losing that race as well.
 */
export function acquireLock(
  dir: string,
  isAlive: (pid: number) => boolean = pidAlive,
  maxAgeMs = 3 * 60 * 60_000,
): { acquired: boolean; release(): void; note?: string } {
  const file = join(dir, "factory.lock");
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const take = () =>
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }), { flag: "wx" });
  // Releases only a lock that is still this tick's: one taken over meanwhile belongs to the tick that took it.
  const release = () => {
    try {
      if (JSON.parse(readFileSync(file, "utf8")).token === token) rmSync(file, { force: true });
    } catch {
      // gone already, or unreadable: nothing of ours to remove
    }
  };
  try {
    take();
    return { acquired: true, release };
  } catch {
    // Fallen through: something is already at `file`, live or stale.
  }
  let heldText = "";
  let held: { pid?: number; at?: string } = {};
  try {
    heldText = readFileSync(file, "utf8");
    held = JSON.parse(heldText);
  } catch {
    // An unreadable lock is treated as stale below; heldText stays "" and won't match anything real.
  }
  // A live holder keeps it, unless the lock is older than any run can last: after a restart its pid may
  // belong to another program (#197).
  if (!lockIsStale(held, isAlive, Date.now(), maxAgeMs))
    return { acquired: false, release: () => {}, note: `pid ${held.pid} since ${held.at}` };
  const graveyard = join(dir, `factory.lock.stale.${process.pid}.${Math.random().toString(36).slice(2)}`);
  try {
    renameSync(file, graveyard);
  } catch {
    return { acquired: false, release: () => {}, note: "lost the race to take over a stale lock" };
  }
  // The rename atomically isolated whatever was actually at `file`: check it is still the exact stale
  // lock just read, not another tick's fresh one that replaced it in the instant between that read and
  // this rename. A mismatch means this tick just took someone else's live lock by accident; put it back
  // and report losing the race, rather than ever proceeding on a lock that belongs to someone else.
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
    return { acquired: false, release: () => {}, note: "lost the race to take over a stale lock" };
  }
  rmSync(graveyard, { force: true });
  try {
    take();
  } catch {
    return { acquired: false, release: () => {}, note: "lost the race to take over a stale lock" };
  }
  return {
    acquired: true,
    release,
    note: `took over a stale lock from pid ${held.pid ?? "?"} (${held.at ?? "unknown time"})${held.pid && isAlive(held.pid) ? "; a process with that pid is still running: if it is the old run, it has run past every limit, so check it" : ""}`,
  };
}

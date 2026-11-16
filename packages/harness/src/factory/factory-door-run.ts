/**
 * The factory tick's side of the door's run gate (#347): the lock marks the run the door sees, and its release
 * ends it. Split from factory-deps.ts, which sits at the module size limit.
 */

import type { doorRunHolder } from "../door/target-post-run.ts";
import type { TickDeps } from "./factory-tick-deps.ts";

/**
 * `deps` with `extra` over it, and a lock that marks the run the door sees (#347) as soon as it is taken, before the
 * tick's first write: recovery's and the claim's writes then carry the key, and a marker a killed run left is
 * replaced rather than blocking them (Qodo on PR 349). Its release, at the tick's end whatever happened, ends the
 * run first. The CI lock is a no-op, so the lock is the one place both modes pass.
 */
export function endsDoorRun(
  deps: TickDeps,
  doorRun: Pick<ReturnType<typeof doorRunHolder>, "start" | "end">,
  extra: Partial<TickDeps> = {},
): TickDeps {
  const all = { ...deps, ...extra };
  return {
    ...all,
    lock: () => {
      const lock = all.lock();
      if (lock.acquired) {
        try {
          doorRun.start(`tick-${process.pid}`);
        } catch (error) {
          // A marker the runner can't replace (another user's): no tick runs, and the lock isn't kept.
          lock.release();
          throw error;
        }
      }
      return {
        ...lock,
        release: () => {
          try {
            doorRun.end();
          } finally {
            lock.release();
          }
        },
      };
    },
  };
}

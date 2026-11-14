/**
 * The runner's own calls to git and npm, each with a time limit: an ordinary call gets `CALL_TIMEOUT_MS`
 * (`./github.ts`), a push, fetch or install the longer one here. Split from factory-tick.ts (#227).
 */
import { spawnSync } from "node:child_process";
import { CALL_TIMEOUT_MS, runExternal } from "./github.ts";

/** The long time limit for a push, a fetch/clone, or an ordinary `npm` call (an install, or `review:wait`,
 * which gives up on its own after its own `--timeout` minutes): a slow network or script can legitimately take
 * longer than everything else the tick runs. An ordinary call gets `CALL_TIMEOUT_MS` (`./github.ts`). */
export const LONG_CALL_TIMEOUT_MS = 10 * 60_000;
/** `revert:check` can legitimately run two full test suites in sequence - with the change, then
 * without it - each allowed up to ten minutes by `runVitest`'s own timeout, so its outer bound must
 * clear that worst case with room for its `gh`/`git` calls too, or a slow but valid run would be
 * killed and misreported as a failed verification (Qodo on PR 155). */
export const REVERT_CHECK_TIMEOUT_MS = 25 * 60_000;

export function git(cwd: string, ...args: string[]): string {
  return runExternal(`git ${args[0] ?? ""}`.trim(), "git", ["-C", cwd, ...args], CALL_TIMEOUT_MS, {
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** For a push, or a fetch/clone: the same as `git`, but with the longer time limit. */
export function gitLong(cwd: string, ...args: string[]): string {
  return runExternal(`git ${args[0] ?? ""}`.trim(), "git", ["-C", cwd, ...args], LONG_CALL_TIMEOUT_MS, {
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Runs an npm script with one time limit, the cross-platform way: a plain `spawnSync("npm", ...)`
 * can't find `npm.cmd` on Windows without a shell (exported so `verifyPrWith`'s own tests can run real
 * npm scripts, on Linux and Windows alike, instead of each re-implementing this). */
export function npm(
  cwd: string,
  args: string[],
  timeoutMs: number = LONG_CALL_TIMEOUT_MS,
  env?: NodeJS.ProcessEnv,
): { status: number | null; output: string } {
  // npm is a .cmd file on Windows, which only a shell can start. The arguments are fixed words and
  // numbers from this file, never ticket text, so joining them into one command line is safe.
  // Bounded like every other external call, so a hang in a script it runs - a stuck fetch, an API
  // call with no timeout of its own - can never stall the whole run and its lock (Qodo on PR 155).
  const result =
    process.platform === "win32"
      ? spawnSync(["npm", ...args].join(" "), { cwd, encoding: "utf8", shell: true, timeout: timeoutMs, env })
      : spawnSync("npm", args, { cwd, encoding: "utf8", timeout: timeoutMs, env });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Blocks for `ms` without spinning: the runner's own steps are synchronous. */
export function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A read-only call, tried up to `tries` times with a pause between: one transient GitHub failure must not
 * cost a run or a tick (AUD-N10). Only for reads: a write that may have landed is never repeated blindly.
 */
export function retried<T>(read: () => T, tries = 3, pauseMs = 3000, pause: (ms: number) => void = pauseSync): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return read();
    } catch (error) {
      if (attempt >= tries) throw error;
      pause(pauseMs * attempt);
    }
  }
}

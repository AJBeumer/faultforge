/**
 * The runner's own calls to git and npm, each with a time limit: an ordinary call gets `CALL_TIMEOUT_MS`
 * (`github.ts`), a push, fetch or install the longer one here.
 */
import { spawnSync } from "node:child_process";
import { CALL_TIMEOUT_MS, runExternal } from "../shared/github.ts";

/** The time limit for a push, a fetch or clone, or an `npm` call: a slow network or install can take longer than
 * anything else the tick runs. */
export const LONG_CALL_TIMEOUT_MS = 10 * 60_000;
/** `revert:check` runs two full test suites, up to ten minutes each, plus its gh and git calls: a tighter limit
 * would kill a slow but valid run and report it as a failed check. */
export const REVERT_CHECK_TIMEOUT_MS = 25 * 60_000;

export function git(cwd: string, ...args: string[]): string {
  return runExternal(`git ${args[0] ?? ""}`.trim(), "git", ["-C", cwd, ...args], CALL_TIMEOUT_MS, {
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** `git` with the longer time limit, for a push, a fetch or a clone. */
export function gitLong(cwd: string, ...args: string[]): string {
  return runExternal(`git ${args[0] ?? ""}`.trim(), "git", ["-C", cwd, ...args], LONG_CALL_TIMEOUT_MS, {
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Runs an npm script with a time limit, on Linux and Windows alike. */
export function npm(
  cwd: string,
  args: string[],
  timeoutMs: number = LONG_CALL_TIMEOUT_MS,
  env?: NodeJS.ProcessEnv,
): { status: number | null; output: string } {
  // npm is a .cmd file on Windows, which only a shell can start. The arguments are fixed words from the
  // runner, never ticket text, so joining them into one command line is safe.
  const result =
    process.platform === "win32"
      ? spawnSync(["npm", ...args].join(" "), { cwd, encoding: "utf8", shell: true, timeout: timeoutMs, env })
      : spawnSync("npm", args, { cwd, encoding: "utf8", timeout: timeoutMs, env });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

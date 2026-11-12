/**
 * Runs the GitHub CLI, with one time-limit policy and one error shape, so every script that reads or
 * writes GitHub shares it instead of carrying its own `gh` wrapper.
 */
import { execFileSync } from "node:child_process";

/** True when a `child_process` error is Node reporting that the call exceeded its `timeout` option. */
export function isTimeoutError(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
}

/**
 * A failed `gh` or `git` call, with the call named so a stop the run reports (the audit, the verify
 * step, a relabel) says which one hung or failed, never just "the runner failed".
 */
export class ExternalCallError extends Error {
  readonly timedOut: boolean;
  readonly stderr: string;
  constructor(label: string, cause: unknown) {
    const timedOut = isTimeoutError(cause);
    const stderr =
      cause && typeof cause === "object" && "stderr" in cause
        ? String((cause as { stderr?: unknown }).stderr ?? "")
        : "";
    const detail = stderr.trim().split("\n").at(-1) || (cause instanceof Error ? cause.message : String(cause));
    super(timedOut ? `${label} timed out` : `${label} failed: ${detail}`);
    this.name = "ExternalCallError";
    this.timedOut = timedOut;
    this.stderr = stderr;
  }
}

/** The time limit for an ordinary `gh` or `git` call. A push or a fetch/clone needs its own, longer
 * limit; callers that need one build it with `runExternal` directly. */
export const CALL_TIMEOUT_MS = 60_000;

/** Runs an external command with a time limit, throwing `ExternalCallError` named after it on failure. */
export function runExternal(
  label: string,
  bin: string,
  args: string[],
  timeoutMs: number,
  extra: { maxBuffer?: number; stdio?: ["ignore", "pipe", "pipe"]; env?: NodeJS.ProcessEnv } = {},
): string {
  try {
    return execFileSync(bin, args, { encoding: "utf8", timeout: timeoutMs, ...extra }) as unknown as string;
  } catch (error) {
    throw new ExternalCallError(label, error);
  }
}

/** Runs `gh`, with the one time limit and a buffer large enough for a big paginated read. */
export function gh(...args: string[]): string {
  return runExternal(`gh ${args[0] ?? ""}`.trim(), "gh", args, CALL_TIMEOUT_MS, { maxBuffer: 64 * 1024 * 1024 });
}

/** `gh`'s output, parsed as JSON. */
export function ghJson<T>(...args: string[]): T {
  return JSON.parse(gh(...args)) as T;
}

/** A REST endpoint through `gh api`, parsed as JSON. The path goes here, never to `ghJson`: `gh repos/...` is not a command (#168). */
export function ghApiJson<T>(path: string): T {
  return ghJson<T>("api", path);
}

/** Every item of a `gh api --paginate --slurp` list endpoint, flattened across pages. */
export function ghAll<T>(path: string, pick: (page: unknown) => T[] = (page) => page as T[]): T[] {
  return (JSON.parse(gh("api", "--paginate", "--slurp", path)) as unknown[]).flatMap(pick);
}

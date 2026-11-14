/**
 * Runs the GitHub CLI, with one time-limit policy, one retry policy and one error shape, so every script
 * that reads or writes GitHub shares it instead of carrying its own `gh` wrapper. A read that fails
 * transiently (a 5xx answer, a rate limit, the network) is tried again, at most three calls in all; a
 * write is called once.
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

/** The `gh` subcommands that only read, by command group. Anything not listed is treated as a write. */
const READ_SUBCOMMANDS: Record<string, readonly string[]> = {
  pr: ["view", "list", "checks", "diff", "status"],
  issue: ["view", "list", "status"],
  repo: ["view", "list"],
  run: ["view", "list"],
  release: ["view", "list"],
  label: ["list"],
  workflow: ["view", "list"],
  auth: ["status"],
};

/** A `gh api` field option, alone (`-f`) or with its value attached (`-fkey=v`, `--field=key=v`). */
const FIELD = /^(-[fF]|--field|--raw-field)$/;
const FIELD_ATTACHED = /^(-[fF](?=.)|--field=|--raw-field=)/;

/**
 * True when `args` only read from GitHub, so repeating them can't change anything. A REST call through
 * `gh api` reads when it names no method but GET and sends no body (a field or `--input` makes gh POST);
 * a GraphQL call reads when its operation is a query, never a mutation. Anything else counts as a write,
 * and is never retried.
 */
export function isReadCall(args: readonly string[]): boolean {
  const [group, sub] = args;
  if (group !== "api") return Boolean(group && sub && READ_SUBCOMMANDS[group]?.includes(sub));
  let method: string | undefined;
  let body = false;
  let query: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i] as string;
    let field: string | undefined;
    if (arg === "-X" || arg === "--method") method = (args[++i] ?? "").toUpperCase();
    else if (arg.startsWith("--method=")) method = arg.slice("--method=".length).toUpperCase();
    else if (/^-X./.test(arg)) method = arg.slice(2).toUpperCase();
    else if (arg === "--input" || arg.startsWith("--input=")) body = true;
    else if (FIELD.test(arg)) field = args[++i] ?? "";
    else if (FIELD_ATTACHED.test(arg)) field = arg.replace(FIELD_ATTACHED, "");
    if (field === undefined) continue;
    body = true;
    if (field.startsWith("query=")) query = field.slice("query=".length);
  }
  if (args.includes("graphql")) {
    // A document holding a mutation anywhere may run it (`operationName` picks one), so it is a write.
    if (query === undefined || /\bmutation\b/.test(query)) return false;
    return (method ?? "POST") === "POST" && /^\s*(query\b|\{)/.test(query);
  }
  return (method ?? "GET") === "GET" && !body;
}

/**
 * True when a failed call may pass if tried again: a 5xx answer, a rate limit (GitHub's secondary limit
 * answers 403 or 429), a network failure, or a call that ran out of time. A 4xx answer, a bad option or
 * an unknown resource fails the same way every time.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof ExternalCallError && error.timedOut) return true;
  const stderr = error instanceof ExternalCallError ? error.stderr : "";
  const text = `${error instanceof Error ? error.message : String(error)}\n${stderr}`;
  return [
    /HTTP 5\d\d\b/,
    /HTTP 429\b/,
    /secondary rate limit|abuse detection/i,
    /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE)\b/,
    /connection reset|connection refused|i\/o timeout|TLS handshake timeout|unexpected EOF|no such host|could not resolve host|error connecting to|network is unreachable/i,
    /Something went wrong while executing your query/i,
  ].some((pattern) => pattern.test(text));
}

/** Blocks for `ms` without spinning: every caller of `gh` is synchronous. */
function pauseSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * How a read is retried: at most `tries` calls in all, with a pause of `baseMs`, then twice that, between
 * them. A setting, not a constant, so a test can count the pauses instead of waiting them out.
 */
export const readRetry = { tries: 3, baseMs: 2_000, pause: pauseSync };

/** Runs `read`, again after a growing pause while it fails transiently, up to `readRetry.tries` calls. */
function retryRead<T>(read: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return read();
    } catch (error) {
      if (attempt >= readRetry.tries || !isTransient(error)) throw error;
      readRetry.pause(readRetry.baseMs * 2 ** (attempt - 1));
    }
  }
}

/**
 * Runs `gh`, with the one time limit and a buffer large enough for a big paginated read. A read
 * (`isReadCall`) that fails transiently is tried again (`readRetry`); a write never is: one that failed
 * may still have landed, and a second would repeat it.
 */
export function gh(...args: string[]): string {
  const call = () =>
    runExternal(`gh ${args[0] ?? ""}`.trim(), "gh", args, CALL_TIMEOUT_MS, { maxBuffer: 64 * 1024 * 1024 });
  return isReadCall(args) ? retryRead(call) : call();
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

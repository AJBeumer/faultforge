/**
 * How a script's entry turns an unexpected error into its "could not run" code (AUD-N3), instead of Node's
 * default exit 1, which most headers give another meaning ("needs help", "not ready", "found problems").
 *
 * Two parts, one table:
 *  - `runEntry(import.meta.url, main)` in the script's guarded entry runs `main` (sync or async). A number it
 *    returns becomes the exit code; an error it throws or rejects with is printed with its stack and the
 *    script's name, and the exit code becomes the script's could-not-run code. Both through `process.exitCode`,
 *    so output already written reaches the terminal before the process ends.
 *  - Loaded first with `tsx --import ./packages/harness/src/entry.ts <script>` (the npm scripts do), this
 *    module also catches what `runEntry` can't: an error while the script's own modules load, and an error
 *    that escapes later (a timer, an unawaited promise). Those end the process at once with the same code,
 *    as Node itself would, but not with 1.
 *
 * A script adopts it by adding its file name and could-not-run code to `COULD_NOT_RUN`, calling `runEntry`,
 * putting `--import ./packages/harness/src/entry.ts` in its npm script, and naming the code in its header.
 * `exit-codes.test.ts` checks all four.
 *
 * Exit codes: none of its own. A script it guards ends with that script's code from `COULD_NOT_RUN`.
 */
import { writeSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/** Each guarded script's could-not-run code, by file name. Its header must name the same code. */
export const COULD_NOT_RUN: Readonly<Record<string, number>> = {
  "docs-check.ts": 2,
  "factory-tick.ts": 3,
  "factory-timeline.ts": 2,
  "guard-install.ts": 2,
  "ticket-ready.ts": 2,
};

/** The could-not-run code of the script at this path or `file:` URL, or undefined when it isn't guarded. */
export function couldNotRunCode(script: string | undefined): number | undefined {
  if (!script) return undefined;
  const name = basename(script.startsWith("file:") ? fileURLToPath(script) : script);
  return Object.hasOwn(COULD_NOT_RUN, name) ? COULD_NOT_RUN[name] : undefined;
}

/** The line printed for an unexpected error: the script, then the stack so the failing step can be found. */
export function failureText(script: string, error: unknown): string {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return `${basename(script)} could not run: ${detail}`;
}

/**
 * Runs a script's `main` and sets its exit code: the number `main` returns, if any, or the script's
 * could-not-run code when `main` throws or rejects. Throws at once if the script isn't in `COULD_NOT_RUN`, so a
 * script can't adopt half of this.
 */
export async function runEntry(
  moduleUrl: string,
  main: () => unknown,
  report: (text: string) => void = (text) => console.error(text),
): Promise<void> {
  const code = couldNotRunCode(moduleUrl);
  if (code === undefined) throw new Error(`${basename(moduleUrl)} has no could-not-run code in entry.ts`);
  try {
    const result = await main();
    if (typeof result === "number") process.exitCode = result;
  } catch (error) {
    report(failureText(fileURLToPath(moduleUrl), error));
    process.exitCode = code;
  }
}

/**
 * The handler for an error nothing caught: print it, exit with the code. Written with `writeSync`, because the
 * process ends straight after and an asynchronous write to a pipe could be lost.
 */
export function uncaughtHandler(
  script: string,
  code: number,
  exit: (code: number) => void = (c) => process.exit(c),
  write: (text: string) => void = (text) => writeSync(2, text),
): (error: unknown) => void {
  return (error) => {
    try {
      write(`${failureText(script, error)}\n`);
    } finally {
      exit(code);
    }
  };
}

// Only when the process was started to run a guarded script, never when a test or another script imports this.
const script = process.argv[1];
const code = couldNotRunCode(script);
if (script && code !== undefined) process.on("uncaughtException", uncaughtHandler(script, code));

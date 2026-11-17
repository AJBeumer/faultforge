/**
 * `npm run ci:wait`: runs `ci-wait.ts`, loaded with a dynamic import inside `cli-entry.ts`, so an unexpected error,
 * even one while its modules load, ends as its "could not run" code and never as Node's default 1. Its last line
 * is `ci:wait exit <code>` on every path: `run()` prints it, and when the module never loaded, this file does.
 *
 * Exit codes: those of `ci-wait.ts` (see its header); 2 also for an unexpected error, at load time or later,
 * printed with its stack on stderr.
 */
import { exitWhenWritten, runEntry } from "../shared/cli-entry.ts";

let started = false;
/** The body's main, noting that it started: from then on, `run()` prints the last line itself. */
const noted = (main: (argv: string[]) => Promise<number>) => (argv: string[]) => {
  started = true;
  return main(argv);
};

try {
  const code = await runEntry(
    "ci:wait",
    async () => noted((await import("../review/ci-wait.ts")).main),
    process.argv.slice(2),
    2,
  );
  if (!started) console.log(`ci:wait exit ${code}`);
  await exitWhenWritten(code);
} catch {
  process.exit(2);
}

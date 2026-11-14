/**
 * `npm run ledger:check`: runs `ledger-check.ts`, loaded with a dynamic import inside `cli-entry.ts`, so an unexpected error,
 * even one while its modules load, ends as its "could not run" code and never as Node's default 1 (AUD-N3).
 *
 * Exit codes: those of `ledger-check.ts` (see its header); 2 also for an unexpected error, at load time or later,
 * printed with its stack on stderr.
 */
import { exitWhenWritten, runEntry } from "./cli-entry.ts";

try {
  await exitWhenWritten(
    await runEntry("ledger:check", async () => (await import("./ledger-check.ts")).main, process.argv.slice(2), 2),
  );
} catch {
  process.exit(2);
}

/**
 * `npm run proof:verify`: runs `proof-run.ts`, loaded with a dynamic import inside `cli-entry.ts`, so an unexpected
 * error, even one while its modules load, ends as its "could not run" code and never as Node's default 1.
 *
 * Exit codes: those of `proof-run.ts` (see its header); 2 also for an unexpected error, printed with its stack.
 */
import { exitWhenWritten, runEntry } from "../shared/cli-entry.ts";

try {
  await exitWhenWritten(
    await runEntry("proof:verify", async () => (await import("../proof/proof-run.ts")).main, process.argv.slice(2), 2),
  );
} catch {
  process.exit(2);
}

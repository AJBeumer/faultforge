/**
 * `npm run clarify:measure`: runs `clarify-measure.ts`, loaded with a dynamic import inside `cli-entry.ts`, so an unexpected error,
 * even one while its modules load, ends as its "could not run" code and never as Node's default 1.
 *
 * Exit codes: those of `clarify-measure.ts` (see its header); 2 also for an unexpected error, at load time or later,
 * printed with its stack on stderr.
 */
import { exitWhenWritten, runEntry } from "../shared/cli-entry.ts";

try {
  await exitWhenWritten(
    await runEntry(
      "clarify:measure",
      async () => (await import("../factory/clarify-measure.ts")).main,
      process.argv.slice(2),
      2,
    ),
  );
} catch {
  process.exit(2);
}

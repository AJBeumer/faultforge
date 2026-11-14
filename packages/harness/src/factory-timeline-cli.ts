/**
 * `npm run factory:timeline`: runs `factory-timeline.ts`, loaded with a dynamic import inside `cli-entry.ts`, so an unexpected error,
 * even one while its modules load, ends as its "could not run" code and never as Node's default 1 (AUD-N3).
 *
 * Exit codes: those of `factory-timeline.ts` (see its header); 2 also for an unexpected error, at load time or later,
 * printed with its stack on stderr.
 */
import { runEntry } from "./cli-entry.ts";

try {
  process.exit(
    await runEntry(
      "factory:timeline",
      async () => (await import("./factory-timeline.ts")).main,
      process.argv.slice(2),
      2,
    ),
  );
} catch {
  process.exit(2);
}

/**
 * `npm run factory:recover`: runs `factory-recover.ts`, loaded with a dynamic import inside `cli-entry.ts`, so an
 * unexpected error, even one while its modules load, ends as its "could not run" code and never as Node's default 1.
 *
 * Exit codes: those of `factory-recover.ts` (see its header); 2 also for an unexpected error, at load time or later,
 * printed with its stack on stderr.
 */
import { exitWhenWritten, runEntry } from "./cli-entry.ts";

try {
  await exitWhenWritten(
    await runEntry(
      "factory:recover",
      async () => (await import("./factory-recover.ts")).main,
      process.argv.slice(2),
      2,
    ),
  );
} catch {
  process.exit(2);
}

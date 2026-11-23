/**
 * `npm run approval:replay`: runs `approval-replay.ts`, loaded with a dynamic import inside `cli-entry.ts`, so an
 * unexpected error, even one while its modules load, ends as its "could not run" code and never as Node's default 1.
 *
 * Exit codes: those of `approval-replay.ts` (see its header); 2 also for an unexpected error, printed with its stack.
 */
import { exitWhenWritten, runEntry } from "../shared/cli-entry.ts";

try {
  await exitWhenWritten(
    await runEntry(
      "approval:replay",
      async () => (await import("../case/approval-replay.ts")).main,
      process.argv.slice(2),
      2,
    ),
  );
} catch {
  process.exit(2);
}

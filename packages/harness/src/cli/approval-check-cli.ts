/**
 * `npm run approval:check`: runs `approval-check.ts`, loaded with a dynamic import inside `cli-entry.ts`, so an
 * unexpected error, even one while its modules load, ends as its "could not run" code and never as Node's default 1.
 *
 * Exit codes: those of `approval-check.ts` (see its header); 2 also for an unexpected error, at load time or later,
 * printed with its stack on stderr.
 */
import { exitWhenWritten, runEntry } from "../shared/cli-entry.ts";

try {
  await exitWhenWritten(
    await runEntry(
      "approval:check",
      async () => (await import("../review/approval-check.ts")).main,
      process.argv.slice(2),
      2,
    ),
  );
} catch {
  process.exit(2);
}

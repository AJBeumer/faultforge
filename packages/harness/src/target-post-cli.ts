/**
 * `npm run target:post`: runs `target-post.ts`, loaded with a dynamic import inside `cli-entry.ts`, so an unexpected
 * error, even one while its modules load, ends as a refusal and never as Node's default 1.
 *
 * Exit codes: those of `target-post.ts` (see its header); 2 also for an unexpected error, at load time or later,
 * printed with its stack on stderr: nothing the door couldn't check is sent.
 */
import { exitWhenWritten, runEntry } from "./cli-entry.ts";

try {
  await exitWhenWritten(
    await runEntry("target:post", async () => (await import("./target-post.ts")).main, process.argv.slice(2), 2),
  );
} catch {
  process.exit(2);
}

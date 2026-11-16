/**
 * `npm run target:post`: runs `target-post.ts` with node, loaded with a dynamic import inside a `try`, so an unexpected
 * error, even one while its modules load, ends as a refusal and never as Node's default 1, its stack written out in
 * full before Node exits (exitCode, never exit()). It imports nothing but the door itself, which the guard holds
 * (the hooks' self/own-files.ts).
 *
 * Exit codes: those of `target-post.ts` (see its header); 2 also for an unexpected error, at load time or later,
 * printed with its stack on stderr: nothing the door couldn't check is sent.
 */
try {
  const { main } = await import("./target-post.ts");
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`target:post: unexpected error, nothing more was sent: ${(error as Error)?.stack ?? String(error)}`);
  process.exitCode = 2;
}

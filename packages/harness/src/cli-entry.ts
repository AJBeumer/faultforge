/**
 * Runs a script's body so that every unexpected error, even one while its modules load, ends as the
 * script's "could not run" code, never Node's default 1 (AUD-N3). The entry file imports only this module
 * statically and loads the body with a dynamic `import()` inside `runEntry`, where a failure can be caught:
 * a static import would fail before any handler exists. Imports nothing but Node itself, for that reason.
 */

/** Loads the body, runs it on `argv`, and returns its exit code, or `couldNotRun` for anything thrown. */
export async function runEntry(
  name: string,
  load: () => Promise<(argv: string[]) => number | Promise<number>>,
  argv: string[],
  couldNotRun = 2,
  error: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  try {
    const main = await load();
    return await main(argv);
  } catch (e) {
    error(`${name} stopped on an unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return couldNotRun;
  }
}

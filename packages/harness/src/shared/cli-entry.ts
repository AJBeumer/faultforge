/**
 * Runs a script's body so that every unexpected error, even one while its modules load, ends as the
 * script's "could not run" code, never Node's default 1 (AUD-N3). The entry file imports only this module
 * statically and loads the body with a dynamic `import()` inside `runEntry`, where a failure can be caught:
 * a static import would fail before any handler exists. Imports nothing but Node itself, for that reason.
 *
 * Exit codes: none of its own; `exitWhenWritten` exits with the code its entry gives it.
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

/**
 * Exits with `code` once everything already written to stdout and stderr has been handed on: `process.exit`
 * straight away can cut off the end of a long output going to a pipe (Qodo on PR 277). Waits at most
 * `limitMs`: a reader that has stopped reading must never keep the process alive (Qodo on PR 277, round 2).
 */
export async function exitWhenWritten(
  code: number,
  streams: { write(chunk: string, done: (error?: Error | null) => void): unknown }[] = [process.stdout, process.stderr],
  exit: (code: number) => void = (c) => process.exit(c),
  limitMs = 5_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((done) => {
    timer = setTimeout(done, limitMs);
  });
  const flushed = streams.map((stream) => new Promise<void>((done) => stream.write("", () => done())));
  await Promise.race([Promise.all(flushed), limit]);
  clearTimeout(timer);
  exit(code);
}

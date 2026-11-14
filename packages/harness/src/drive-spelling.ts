/**
 * Whether Vitest was started from a spelling of the working folder that isn't its real one (AUD-M25).
 *
 * On Windows, Vitest started from `d:\…` loads its runner by that spelling, while each test file's
 * `import "vitest"` resolves through the real path, `D:\…`. Node then holds two copies of Vitest and every test
 * file fails with "Cannot read properties of undefined (reading 'config')", which says nothing about the code.
 * `npm test` avoids this by starting Vitest from the real path (`vitest-run.ts`); `vitest.config.ts` uses this
 * check to stop a direct `npx vitest` from the other spelling with a message that says what to run instead.
 */

/**
 * A message when `cwd` is its real path spelled in another case (`d:\…` for `D:\…`), or undefined. A path that
 * differs in more than case, such as a junction or a symlink to the checkout, is left alone: that is not the
 * failure measured here (Qodo on PR 260).
 */
export function spellingProblem(cwd: string, real: string): string | undefined {
  if (cwd === real || cwd.toLowerCase() !== real.toLowerCase()) return undefined;
  return (
    `Vitest was started from "${cwd}", but this folder's real path is "${real}". ` +
    "Started that way every test file fails to load. Run `npm test` (or `npm run test:integration`), " +
    `or start Vitest from "${real}".`
  );
}

/** The same path with its drive letter in the other case, or undefined when it has none. */
export function otherDriveSpelling(path: string): string | undefined {
  const drive = path.match(/^([A-Za-z]):/)?.[1];
  if (!drive) return undefined;
  const swapped = drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase();
  return swapped + path.slice(1);
}

/**
 * Starts Vitest from the working folder's real spelling, so `npm test` gives the same result whatever case
 * the drive letter was typed in (#195).
 *
 *   tsx packages/harness/src/vitest-run.ts run --project unit
 *
 * Why: started from `d:\…` on Windows, Vitest loads its runner by that spelling, while each test file's
 * `import "vitest"` is resolved through the real path, `D:\…`. Node then holds two copies of Vitest, and
 * `describe` finds no runner state: every test file fails with "Cannot read properties of undefined
 * (reading 'config')". Setting Vitest's `root` or Vite's `preserveSymlinks` in the config does not help,
 * because the runner's own path is fixed before the config is read. Starting Vitest from the real path
 * gives both one spelling. On Linux and macOS the real path is the path, so nothing changes there.
 *
 * Exit codes: Vitest's own (0 every test passed, 1 a test failed or Vitest could not run); 1 also when
 * Vitest could not be started at all.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";

const root = realpathSync.native(process.cwd());
const result = spawnSync(
  process.execPath,
  [join(root, "node_modules", "vitest", "vitest.mjs"), ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: "inherit",
  },
);
if (result.error) console.error(`vitest-run: could not start Vitest: ${result.error.message}`);
process.exit(result.status ?? 1);

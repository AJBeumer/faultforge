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
 * Vitest could not be started at all. A signal sent to the launcher is passed on to Vitest, and a signal
 * that stops Vitest stops the launcher the same way.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";

const root = realpathSync.native(process.cwd());
const child = spawn(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
});

// Stopping the launcher stops Vitest too: the signal is passed on, and the launcher waits for Vitest to end.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`vitest-run: could not start Vitest: ${error.message}`);
  process.exit(1);
});

// Vitest's own ending is the launcher's: its exit code, or the signal that stopped it.
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

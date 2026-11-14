import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { spellingProblem } from "./packages/harness/src/drive-spelling.ts";

// Started from another spelling of this folder (`d:\…` for `D:\…`), every test file fails to load with an error
// that says nothing about the code. Stop with one that says what to run instead (AUD-M25).
// Windows only, and only for a difference in case: a junction or symlink to the checkout is left as it was.
if (process.platform === "win32") {
  const spelling = spellingProblem(process.cwd(), realpathSync.native(process.cwd()));
  if (spelling) throw new Error(spelling);
}

/**
 * A few tests build fixtures under the OS temp directory by a fixed name (one reviewed-repo config,
 * one body file). Giving each `vitest` invocation its own temp directory, instead of the machine-wide
 * one, means those fixed names can't collide with a concurrent run on the same machine (#110): this
 * repo's own, run twice at once, or alongside the reviewed repo's. `os.tmpdir()` reads `TMPDIR` /
 * `TEMP` / `TMP` at call time, so setting them for the worker processes is enough; nothing that reads
 * them needs to change. Removed on exit, so a run doesn't leave its scratch fixtures behind.
 */
const scratchTmp = mkdtempSync(join(tmpdir(), "faultforge-vitest-"));
process.on("exit", () => rmSync(scratchTmp, { recursive: true, force: true }));

/**
 * Two projects. `unit` is every `<name>.test.ts` next to the code it tests, and runs on `npm test` and in
 * `npm run check`. `integration` is the slow tests under `packages/<package>/test/` that need a checkout, a
 * network or a real process, and runs on `npm run test:integration`. Template proof tests are neither: they
 * run only through `npm run inject`, against a target checkout (see vitest.proof.config.ts).
 */
export default defineConfig({
  test: {
    env: { TMPDIR: scratchTmp, TMP: scratchTmp, TEMP: scratchTmp },
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/**/*.test.ts", ".claude/**/*.test.ts"],
          exclude: ["**/node_modules/**", "packages/*/test/**"],
          // Many unit tests build a real git repository. A shared Windows runner can take over the 5 s
          // default for one of them (a merge-commit test took 5.6 s), which is a slow runner, not a bug. Linux keeps 5 s.
          testTimeout: process.platform === "win32" ? 30_000 : 5_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["packages/*/test/**/*.test.ts"],
          // The folder may be empty until the first integration test lands.
          passWithNoTests: true,
        },
      },
    ],
  },
});

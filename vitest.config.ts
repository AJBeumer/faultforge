import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

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

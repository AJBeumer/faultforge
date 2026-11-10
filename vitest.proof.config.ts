import { defineConfig } from "vitest/config";

/**
 * Used by `npm run inject` to run one proof test at a time, with a scratch folder holding only that
 * file (and its subfolders, if its `proofTest` path has any) as root.
 */
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
  },
});

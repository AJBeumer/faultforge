import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Template proof tests run only through `npm run inject`, against a target checkout.
    include: ["packages/**/*.test.ts", ".claude/**/*.test.ts"],
  },
});

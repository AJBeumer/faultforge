import { defineConfig } from "vitest/config";

/** Used by `npm run inject` to run one template's proof test, with the template folder as root. */
export default defineConfig({
  test: {
    include: ["*.test.ts"],
  },
});

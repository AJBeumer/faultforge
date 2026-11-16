import { describe, expect, it } from "vitest";
import { CALL_TIMEOUT_MS } from "../shared/github.ts";
import { LONG_CALL_TIMEOUT_MS } from "./factory-exec.ts";

describe("time limits on gh and git calls", () => {
  it("gives the long limit to pushes and clones, longer than the default every other call gets", () => {
    expect(LONG_CALL_TIMEOUT_MS).toBeGreaterThan(CALL_TIMEOUT_MS);
  });
  // Whether the limit cuts off a real, hanging process is checked in the integration suite
  // (packages/harness/test/factory-tick-timeouts.test.ts): this file runs no process.
});

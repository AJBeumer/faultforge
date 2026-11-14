import { describe, expect, it } from "vitest";
import { LONG_CALL_TIMEOUT_MS, retried } from "./factory-exec.ts";
import { CALL_TIMEOUT_MS } from "./github.ts";

describe("time limits on gh and git calls (#107)", () => {
  // isTimeoutError and ExternalCallError moved to github.ts (#108); covered by github.test.ts.
  it("gives the long limit to pushes and clones, longer than the default every other call gets", () => {
    expect(LONG_CALL_TIMEOUT_MS).toBeGreaterThan(CALL_TIMEOUT_MS);
  });
  // Whether the time limit actually cuts off a real, hanging process is checked in
  // packages/harness/test/factory-tick-timeouts.test.ts: spawning a process belongs in the integration
  // suite, never in this file's fast, fake-only checks.
});

describe("retried: a read gets three tries (AUD-N10)", () => {
  it("returns the first answer that comes, pausing longer each time", () => {
    const pauses: number[] = [];
    let calls = 0;
    const value = retried(
      () => {
        calls++;
        if (calls < 3) throw new Error("HTTP 502");
        return "ok";
      },
      3,
      100,
      (ms) => pauses.push(ms),
    );
    expect(value).toBe("ok");
    expect(pauses).toEqual([100, 200]);
  });

  it("passes the last failure on after the last try", () => {
    let calls = 0;
    expect(() =>
      retried(
        () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        3,
        1,
        () => {},
      ),
    ).toThrow("fail 3");
  });
});

/**
 * The alert's GitHub calls go through the shared `gh` wrapper: each has a time limit, a read that
 * fails transiently is tried again, and a write is called once. gh itself is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "node:child_process";
import { CALL_TIMEOUT_MS, readRetry } from "../shared/github.ts";
import { ghIssues } from "./alert.ts";

const transient = () => {
  throw Object.assign(new Error("gh failed"), { stderr: "HTTP 502: Bad Gateway" });
};

describe("the alert's gh calls", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    readRetry.pause = () => {};
  });

  it("tries a transiently failed read of the open alerts again", () => {
    vi.mocked(execFileSync).mockImplementationOnce(transient).mockReturnValueOnce('[{"number":4,"title":"t"}]');
    expect(ghIssues("o/r").openAlerts()).toEqual([{ number: 4, title: "t" }]);
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(2);
  });

  it("gives every call the shared time limit", () => {
    vi.mocked(execFileSync).mockReturnValue("[]");
    ghIssues("o/r").openAlerts();
    ghIssues("o/r").comment(4, "body");
    for (const call of vi.mocked(execFileSync).mock.calls) {
      expect(call[2]).toMatchObject({ timeout: CALL_TIMEOUT_MS });
    }
  });

  it("calls a write once, even when it fails transiently", () => {
    vi.mocked(execFileSync).mockImplementation(transient);
    expect(() => ghIssues("o/r").comment(4, "body")).toThrow();
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "node:child_process";
import { CALL_TIMEOUT_MS, ExternalCallError, gh, ghAll, ghJson, isTimeoutError } from "./github.ts";

describe("isTimeoutError", () => {
  it("recognises Node's ETIMEDOUT and nothing else", () => {
    expect(isTimeoutError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isTimeoutError({ code: "ENOENT" })).toBe(false);
    expect(isTimeoutError(new Error("boom"))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
  });
});

describe("ExternalCallError", () => {
  it("names the call and marks it as a timeout", () => {
    const err = new ExternalCallError("git push", { code: "ETIMEDOUT" });
    expect(err.timedOut).toBe(true);
    expect(err.message).toBe("git push timed out");
  });

  it("keeps gh's own detail for a call that failed without timing out", () => {
    const err = new ExternalCallError("gh api", {
      stderr: "gh: HTTP 403: Forbidden (https://api.github.com/x)\n",
    });
    expect(err.timedOut).toBe(false);
    expect(err.message).toBe("gh api failed: gh: HTTP 403: Forbidden (https://api.github.com/x)");
  });
});

describe("gh, ghJson and ghAll: one time-limit policy for every caller", () => {
  it("runs gh with the shared time limit and a large buffer, and names the failure when it fails", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw { stderr: "gh: HTTP 404: Not Found (...)\n" };
    });
    expect(() => gh("pr", "view", "9")).toThrow(ExternalCallError);
    expect(vi.mocked(execFileSync).mock.calls[0]?.[0]).toBe("gh");
    expect(vi.mocked(execFileSync).mock.calls[0]?.[2]).toMatchObject({
      timeout: CALL_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  });

  it("ghJson parses gh's output", () => {
    vi.mocked(execFileSync).mockReturnValueOnce('{"state":"OPEN"}');
    expect(ghJson<{ state: string }>("pr", "view", "9").state).toBe("OPEN");
  });

  it("ghAll flattens every page from --paginate --slurp", () => {
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]));
    expect(ghAll<{ id: number }>("repos/o/r/issues").map((i) => i.id)).toEqual([1, 2, 3]);
  });
});

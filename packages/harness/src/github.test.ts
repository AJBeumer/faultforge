import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "node:child_process";
import {
  CALL_TIMEOUT_MS,
  ExternalCallError,
  gh,
  ghAll,
  ghApiJson,
  ghJson,
  isReadCall,
  isTimeoutError,
  isTransient,
  readRetry,
} from "./github.ts";

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

  it("ghApiJson runs gh api with the path and parses the JSON", () => {
    vi.mocked(execFileSync).mockReturnValueOnce('[{"number":7}]');
    expect(ghApiJson<{ number: number }[]>("repos/o/r/pulls?page=1")).toEqual([{ number: 7 }]);
    expect(vi.mocked(execFileSync).mock.calls.at(-1)?.[1]).toEqual(["api", "repos/o/r/pulls?page=1"]);
  });

  it("ghAll flattens every page from --paginate --slurp", () => {
    vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify([[{ id: 1 }, { id: 2 }], [{ id: 3 }]]));
    expect(ghAll<{ id: number }>("repos/o/r/issues").map((i) => i.id)).toEqual([1, 2, 3]);
  });
});

describe("isReadCall: only a call that can't change anything is retried", () => {
  it("knows the read-only gh commands and treats every other as a write", () => {
    expect(isReadCall(["pr", "view", "9"])).toBe(true);
    expect(isReadCall(["pr", "list", "--repo", "o/r"])).toBe(true);
    expect(isReadCall(["issue", "view", "3"])).toBe(true);
    expect(isReadCall(["pr", "create", "--title", "t"])).toBe(false);
    expect(isReadCall(["pr", "merge", "9"])).toBe(false);
    expect(isReadCall(["issue", "comment", "3", "--body", "b"])).toBe(false);
    expect(isReadCall(["issue", "edit", "3", "--add-label", "x"])).toBe(false);
    expect(isReadCall(["something", "new"])).toBe(false);
    expect(isReadCall([])).toBe(false);
  });

  it("reads a REST call only when it is a GET with no body", () => {
    expect(isReadCall(["api", "repos/o/r/issues"])).toBe(true);
    expect(isReadCall(["api", "--paginate", "--slurp", "repos/o/r/issues"])).toBe(true);
    expect(isReadCall(["api", "-X", "GET", "repos/o/r"])).toBe(true);
    expect(isReadCall(["api", "-X", "DELETE", "repos/o/r/issues/1/labels/x"])).toBe(false);
    expect(isReadCall(["api", "-XPATCH", "repos/o/r"])).toBe(false);
    expect(isReadCall(["api", "--method=PUT", "repos/o/r"])).toBe(false);
    expect(isReadCall(["api", "--method", "post", "repos/o/r"])).toBe(false);
    // A field makes gh POST, unless the method is named.
    expect(isReadCall(["api", "repos/o/r/issues", "-f", "title=x"])).toBe(false);
    expect(isReadCall(["api", "repos/o/r/issues", "-Fnumber=3"])).toBe(false);
    expect(isReadCall(["api", "repos/o/r/issues", "--raw-field=body=x"])).toBe(false);
    expect(isReadCall(["api", "repos/o/r/issues", "--input", "body.json"])).toBe(false);
  });

  it("reads a GraphQL query, never a mutation", () => {
    expect(isReadCall(["api", "graphql", "-f", "query=query($n: Int!) { viewer { login } }", "-F", "n=1"])).toBe(true);
    expect(isReadCall(["api", "graphql", "-f", "query={ viewer { login } }"])).toBe(true);
    expect(isReadCall(["api", "graphql", "-f", "query=mutation { addStar(input: {}) { clientMutationId } }"])).toBe(
      false,
    );
    expect(isReadCall(["api", "graphql"])).toBe(false);
    // A document with a query first and a mutation after: operationName may run the mutation.
    const mixed = "query=query A { viewer { login } } mutation B { addStar(input: {}) { clientMutationId } }";
    expect(isReadCall(["api", "graphql", "-f", mixed, "-f", "operationName=B"])).toBe(false);
  });
});

describe("isTransient: what may pass if tried again", () => {
  const failed = (stderr: string) => new ExternalCallError("gh api", { stderr });

  it("is a 5xx, a rate limit, the network, or a call that ran out of time", () => {
    expect(isTransient(failed("gh: HTTP 502: Bad Gateway (https://api.github.com/x)\n"))).toBe(true);
    expect(isTransient(failed("gh: HTTP 503: Service Unavailable\n"))).toBe(true);
    expect(isTransient(failed("gh: You have exceeded a secondary rate limit. HTTP 403\n"))).toBe(true);
    expect(isTransient(failed("gh: HTTP 429: Too Many Requests\n"))).toBe(true);
    expect(isTransient(failed('Post "https://api.github.com/graphql": read: connection reset by peer\n'))).toBe(true);
    expect(isTransient(failed("error connecting to api.github.com\n"))).toBe(true);
    expect(isTransient(failed("GraphQL: Something went wrong while executing your query.\n"))).toBe(true);
    expect(isTransient(new ExternalCallError("gh api", { code: "ETIMEDOUT" }))).toBe(true);
  });

  it("is never a 4xx answer that fails the same way every time", () => {
    expect(isTransient(failed("gh: HTTP 404: Not Found (https://api.github.com/x)\n"))).toBe(false);
    expect(isTransient(failed("gh: HTTP 403: Resource not accessible by personal access token\n"))).toBe(false);
    expect(isTransient(failed("gh: HTTP 422: Validation Failed\n"))).toBe(false);
    expect(isTransient(failed("unknown flag: --nope\n"))).toBe(false);
  });
});

describe("gh: a read is retried with backoff, a write never is", () => {
  const original = { ...readRetry };
  const pauses: number[] = [];
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    pauses.length = 0;
    readRetry.pause = (ms) => {
      pauses.push(ms);
    };
  });
  afterEach(() => {
    Object.assign(readRetry, original);
  });
  const fail = (stderr: string) => () => {
    throw { stderr };
  };

  it("tries a read again after a transient failure, waiting longer each time", () => {
    vi.mocked(execFileSync)
      .mockImplementationOnce(fail("gh: HTTP 502: Bad Gateway\n"))
      .mockImplementationOnce(fail("connection reset by peer\n"))
      .mockReturnValueOnce('[{"number":7}]');
    expect(ghApiJson<{ number: number }[]>("repos/o/r/issues")).toEqual([{ number: 7 }]);
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(3);
    expect(pauses).toEqual([readRetry.baseMs, readRetry.baseMs * 2]);
  });

  it("stops after three calls and reports the last failure", () => {
    vi.mocked(execFileSync).mockImplementation(fail("gh: HTTP 503: Service Unavailable\n"));
    expect(() => ghAll("repos/o/r/issues")).toThrow(/HTTP 503/);
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(3);
    expect(pauses).toHaveLength(2);
  });

  it("retries ghJson's reads too", () => {
    vi.mocked(execFileSync)
      .mockImplementationOnce(fail("gh: You have exceeded a secondary rate limit\n"))
      .mockReturnValueOnce('{"state":"OPEN"}');
    expect(ghJson<{ state: string }>("pr", "view", "9", "--json", "state").state).toBe("OPEN");
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(2);
  });

  it("doesn't retry a read that fails the same way every time", () => {
    vi.mocked(execFileSync).mockImplementation(fail("gh: HTTP 404: Not Found\n"));
    expect(() => gh("pr", "view", "9")).toThrow(/404/);
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
    expect(pauses).toEqual([]);
  });

  it("never retries a write, even after a transient failure: it may have landed", () => {
    vi.mocked(execFileSync).mockImplementation(fail("gh: HTTP 502: Bad Gateway\n"));
    expect(() => gh("issue", "comment", "3", "--repo", "o/r", "--body", "b")).toThrow(/502/);
    expect(() => gh("api", "-X", "DELETE", "repos/o/r/issues/3/labels/x")).toThrow(/502/);
    expect(() => gh("api", "repos/o/r/issues", "-f", "title=x")).toThrow(/502/);
    expect(() => gh("api", "graphql", "-f", "query=mutation { x }")).toThrow(/502/);
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(4);
    expect(pauses).toEqual([]);
  });
});

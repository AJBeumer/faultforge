import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSessionLost, parseRpcBody, parseToolText, QodoApi, TransportError } from "./qodo-api.ts";
import {
  ciOrUnavailable,
  findingsFor,
  findingsShapeProblem,
  openFindings,
  parseArgs,
  type QodoReview,
  reviewEffort,
  reviewState,
  saveCommentFeeds,
  summarizeCi,
  waitForHead,
  waitForReview,
} from "./review-wait.ts";

const pr1: QodoReview = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/qodo-target-pr1.json"), "utf8"));
const PR1_HEAD = "c7ffd1540d6ae37e15450c8342d83dc8f866884f";

describe("findingsFor", () => {
  it("reproduces FF-0001's finding from target PR 1", () => {
    expect(findingsFor(pr1, PR1_HEAD)).toEqual([
      expect.objectContaining({
        id: "db9e3625-ca25-490b-8bdf-a61f58b4f0bf",
        file: "src/bookings/create.ts",
        lines: [33, 33],
        severity: "action_required",
        category: "Security",
        title: "Booking replays expose another user's data",
      }),
    ]);
  });

  it("keeps only findings on the given commit", () => {
    expect(findingsFor(pr1, "0".repeat(40))).toEqual([]);
  });
});

describe("reviewState", () => {
  it("is complete only for a completed run on exactly the head commit", () => {
    expect(reviewState(pr1, PR1_HEAD)).toBe("complete");
    expect(reviewState(pr1, "f".repeat(40))).toBe("not-started");
  });

  it("is running while the run for the head commit isn't completed", () => {
    const running = { review_session: { commit_sha: PR1_HEAD, status: "running", review_complete: false } };
    expect(reviewState(running, PR1_HEAD)).toBe("running");
  });

  it("recognises a run Qodo finished but skipped (real response from a docs-only PR)", () => {
    const skipped: QodoReview = JSON.parse(
      readFileSync(join(import.meta.dirname, "../fixtures/qodo-skipped-docs-pr.json"), "utf8"),
    );
    expect(reviewState(skipped, "81fe91d80d019ae0da78c3f4b5f133059834742d")).toBe("skipped");
    expect(findingsFor(skipped, "81fe91d80d019ae0da78c3f4b5f133059834742d")).toEqual([]);
  });

  it("isn't complete when the status says completed but review_complete is false", () => {
    const partial = { review_session: { commit_sha: PR1_HEAD, status: "completed", review_complete: false } };
    expect(reviewState(partial, PR1_HEAD)).toBe("running");
  });
});

/** A fake clock and a scripted sequence of API answers. */
function scripted(answers: QodoReview[]) {
  let t = 0;
  let i = 0;
  let polls = 0;
  return {
    deps: {
      fetchReview: async () => answers[Math.min(i++, answers.length - 1)] ?? {},
      onPoll: async () => {
        polls++;
      },
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    },
    polls: () => polls,
  };
}

describe("waitForReview", () => {
  const older = { review_session: { commit_sha: "a".repeat(40), status: "completed", review_complete: true } };
  const running = { review_session: { commit_sha: PR1_HEAD, status: "running", review_complete: false } };

  it("keeps waiting through an older commit's finished review and a running one, then completes", async () => {
    const { deps, polls } = scripted([older, running, pr1]);
    const result = await waitForReview(PR1_HEAD, deps);
    expect(result.state).toBe("complete");
    expect(result.polls).toBe(3);
    // Three saves while waiting, and one last save after the review completed.
    expect(polls()).toBe(4);
  });

  it("stops waiting when Qodo skips the review, and says so", async () => {
    const skipped = {
      review_session: { commit_sha: PR1_HEAD, status: "completed", review_complete: false },
      review_runs: [{ commit_sha: PR1_HEAD, review_effort: "skip", status: "completed" }],
    };
    const { deps } = scripted([running, skipped]);
    expect((await waitForReview(PR1_HEAD, deps)).state).toBe("skipped");
  });

  it("times out when the head commit is never reviewed", async () => {
    const { deps } = scripted([older]);
    const result = await waitForReview(PR1_HEAD, deps, { timeoutMs: 60_000, intervalMs: 20_000 });
    expect(result.state).toBe("timeout");
    // Polls at 0, 20, 40 and 60 seconds: one last look at the deadline itself.
    expect(result.polls).toBe(4);
  });
});

describe("review findings on PR 59", () => {
  const lite: QodoReview = JSON.parse(
    readFileSync(join(import.meta.dirname, "../fixtures/qodo-lite-rereview.json"), "utf8"),
  );
  const LITE_HEAD = "a7dd788";

  it("reports findings still open from earlier commits, not only the head's", () => {
    const head = lite.review_session?.commit_sha ?? "";
    expect(head.startsWith(LITE_HEAD)).toBe(true);
    expect(findingsFor(lite, head)).toEqual([]);
    expect(openFindings(lite)).toHaveLength(9);
    expect(openFindings(lite)[0]).toMatchObject({ commit: "4d4d112", severity: "action_required" });
  });

  it("reports how deeply Qodo reviewed the head commit", () => {
    expect(reviewEffort(lite, lite.review_session?.commit_sha ?? "")).toBe("lite");
  });

  it("saves the comments one last time after the review completes", async () => {
    const calls: string[] = [];
    await waitForReview(PR1_HEAD, {
      fetchReview: async () => {
        calls.push("fetch");
        return pr1;
      },
      onPoll: async () => {
        calls.push("poll");
      },
      now: () => 0,
      sleep: async () => {},
    });
    expect(calls).toEqual(["poll", "fetch", "poll"]);
  });
});

describe("parseToolText and parseRpcBody (review findings on PR 59)", () => {
  it("throws on a tool error instead of treating it as data", () => {
    expect(() => parseToolText({ isError: true, content: [{ type: "text", text: '{"error":"x"}' }] })).toThrow(/x/);
  });

  it("reads JSON with leading whitespace", () => {
    expect(parseRpcBody('  \n{"result":{"ok":true}}')).toEqual({ result: { ok: true } });
  });

  it("joins an event's data lines", () => {
    expect(parseRpcBody('event: message\ndata: {"result":\ndata: {"ok":true}}\n\n')).toEqual({ result: { ok: true } });
  });
});

describe("isSessionLost", () => {
  it("matches a transport-level 404 or a JSON-RPC error naming a session", () => {
    expect(isSessionLost(new TransportError("tools/call: HTTP 404 not found"))).toBe(true);
    expect(isSessionLost(new TransportError('tools/call: {"message":"Session not found"}'))).toBe(true);
  });

  it("doesn't match a transport error unrelated to a session", () => {
    expect(isSessionLost(new TransportError("tools/call: HTTP 500 server error"))).toBe(false);
  });

  it("never matches a non-transport error, however its text reads", () => {
    // Qodo's own tool-level answer (isError), not a sign the connection was lost.
    expect(isSessionLost(new Error("Qodo tool error: no review session for that commit"))).toBe(false);
  });
});

describe("review findings on PR 59, second round", () => {
  it("records when the review was first seen complete", async () => {
    let t = 1_000;
    const result = await waitForReview(PR1_HEAD, {
      fetchReview: async () => pr1,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(result).toMatchObject({ state: "complete", seenCompleteAt: 1_000 });
  });
});

describe("review findings on PR 61", () => {
  const failOnce = (answer: QodoReview) => {
    let calls = 0;
    return async () => {
      if (calls++ === 0) throw new Error("fetch failed");
      return answer;
    };
  };
  const clock = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };

  it("keeps waiting through a failed poll and still sees the review complete", async () => {
    const errors: unknown[] = [];
    const result = await waitForReview(PR1_HEAD, {
      fetchReview: failOnce(pr1),
      onError: (error) => errors.push(error),
      ...clock(),
    });
    expect(result).toMatchObject({ state: "complete", polls: 2 });
    expect(errors).toHaveLength(1);
  });

  it("keeps waiting when saving the comments fails once", async () => {
    let saves = 0;
    const result = await waitForReview(PR1_HEAD, {
      fetchReview: async () => pr1,
      onPoll: async () => {
        if (saves++ === 0) throw new Error("gh failed");
      },
      ...clock(),
    });
    expect(result.state).toBe("complete");
  });

  it("gives up with the error, not a timeout, when every poll failed", async () => {
    const run = waitForReview(
      PR1_HEAD,
      {
        fetchReview: async () => {
          throw new Error("unauthorized");
        },
        ...clock(),
      },
      { timeoutMs: 60_000, intervalMs: 20_000 },
    );
    await expect(run).rejects.toThrow("unauthorized");
  });
});

describe("review findings on PR 61, third round", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("connects again on the next call after the first connection failed", async () => {
    vi.stubEnv("QODO_API_KEY", "test-key");
    let failed = false;
    const methods: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const { method, id } = JSON.parse(init.body);
      methods.push(method);
      if (!failed) {
        failed = true;
        throw new Error("fetch failed");
      }
      const result = method === "tools/call" ? { content: [{ type: "text", text: '{"ok":true}' }] } : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
    });
    const api = new QodoApi();
    await expect(api.call("get-pr-review-findings")).rejects.toThrow("fetch failed");
    await expect(api.call("get-pr-review-findings")).resolves.toEqual({ ok: true });
    expect(methods).toEqual(["initialize", "initialize", "notifications/initialized", "tools/call"]);
  });

  it("doesn't report a review complete until the last save of its comments succeeded", async () => {
    let t = 0;
    let saves = 0;
    const result = await waitForReview(PR1_HEAD, {
      fetchReview: async () => pr1,
      // The save after the review is seen complete fails once.
      onPoll: async () => {
        if (++saves === 2) throw new Error("gh failed");
      },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(result.state).toBe("complete");
    expect(saves).toBeGreaterThanOrEqual(4);
  });

  it("stops with the error when the comments can never be saved", async () => {
    let t = 0;
    const run = waitForReview(
      PR1_HEAD,
      {
        fetchReview: async () => pr1,
        onPoll: async () => {
          throw new Error("gh failed");
        },
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      },
      { timeoutMs: 60_000, intervalMs: 20_000 },
    );
    await expect(run).rejects.toThrow("gh failed");
  });
});

describe("waitForHead (#67: review:wait on PR 65 read the old head right after a push)", () => {
  // PR 65 on 9 Nov: GitHub still showed 506f56d a second after 56fb13c was pushed.
  const OLD = `506f56d${"0".repeat(33)}`;
  const PUSHED = `56fb13c${"1".repeat(33)}`;
  const OTHER = `9abcdef${"2".repeat(33)}`;

  /** A fake PR head that answers from a script, one entry per poll; an Error entry is a failed read. */
  function heads(...script: (string | Error)[]) {
    let i = 0;
    let t = 0;
    const seen: string[] = [];
    return {
      seen,
      deps: {
        readHead: async () => {
          const next = script[Math.min(i++, script.length - 1)] as string | Error;
          if (next instanceof Error) throw next;
          seen.push(next);
          return next;
        },
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
        },
      },
    };
  }

  it("waits out the old head for the first polls, then returns the pushed commit", async () => {
    const { deps } = heads(OLD, OLD, PUSHED);
    const result = await waitForHead(PUSHED, deps, { timeoutMs: 60_000, intervalMs: 5_000 });
    expect(result).toEqual({ state: "reached", head: PUSHED, polls: 3, seen: [OLD, PUSHED] });
  });

  it("accepts the short form of the commit and returns the full one", async () => {
    const { deps } = heads(PUSHED);
    const result = await waitForHead("56fb13c", deps, { timeoutMs: 60_000, intervalMs: 5_000 });
    expect(result).toMatchObject({ state: "reached", head: PUSHED });
  });

  it("stops when the head moves to a third commit, naming it", async () => {
    const { deps } = heads(OLD, OTHER, PUSHED);
    const result = await waitForHead(PUSHED, deps, { timeoutMs: 60_000, intervalMs: 5_000 });
    expect(result).toMatchObject({ state: "moved", head: OTHER, polls: 2 });
  });

  it("times out naming the head it saw when the commit never arrives", async () => {
    const { deps } = heads(OLD);
    const result = await waitForHead(PUSHED, deps, { timeoutMs: 20_000, intervalMs: 5_000 });
    // Reads at 0, 5, 10, 15 and 20 seconds: one last look at the deadline itself.
    expect(result).toEqual({ state: "timeout", head: OLD, polls: 5, seen: [OLD] });
  });

  it("keeps polling through a failed read", async () => {
    const { deps } = heads(new Error("gh: 502"), PUSHED);
    const result = await waitForHead(PUSHED, { ...deps, onError: () => {} }, { timeoutMs: 60_000, intervalMs: 5_000 });
    expect(result).toMatchObject({ state: "reached", head: PUSHED, polls: 2 });
  });

  it("returns failed with the error, not a timeout, when every read failed, so the attempt can be recorded", async () => {
    // Qodo on PR 98: a throw here skipped the head-wait record, leaving no trace of the attempts.
    const { deps } = heads(new Error("gh: 502"));
    const result = await waitForHead(PUSHED, { ...deps, onError: () => {} }, { timeoutMs: 10_000, intervalMs: 5_000 });
    expect(result).toEqual({ state: "failed", head: null, polls: 3, seen: [], error: "gh: 502" });
  });
});

describe("parseArgs", () => {
  it("behaves as before without --commit", () => {
    expect(parseArgs(["faultforge", "92"])).toEqual({
      repoKey: "faultforge",
      pr: 92,
      timeoutMinutes: 20,
      commit: null,
    });
  });

  it("reads --commit and --timeout in any order", () => {
    expect(parseArgs(["target", "9", "--commit", "56fb13c", "--timeout", "5"])).toEqual({
      repoKey: "target",
      pr: 9,
      timeoutMinutes: 5,
      commit: "56fb13c",
    });
  });

  it("refuses a commit that isn't a hex id of at least 7 characters", () => {
    expect(parseArgs(["target", "9", "--commit", "HEAD"])).toBeNull();
    expect(parseArgs(["target", "9", "--commit", "56fb1"])).toBeNull();
    expect(parseArgs(["target", "9", "--commit"])).toBeNull();
  });

  it("refuses a missing PR number or a bad timeout", () => {
    expect(parseArgs(["target"])).toBeNull();
    expect(parseArgs(["target", "x"])).toBeNull();
    expect(parseArgs(["target", "9", "--timeout", "soon"])).toBeNull();
  });
});

describe("review findings on PR 98", () => {
  const HEAD = PR1_HEAD;
  const NEWER = `56fb13c${"1".repeat(33)}`;

  it("doesn't report a review complete when the PR head moved on while waiting", async () => {
    // Head reached, review of it completes, but meanwhile someone pushed again.
    const result = await waitForReview(HEAD, {
      fetchReview: async () => pr1,
      readHead: async () => NEWER,
      now: () => 0,
      sleep: async () => {},
    });
    expect(result).toMatchObject({ state: "moved", head: NEWER });
  });

  it("reports the review complete when the head is still the commit waited for", async () => {
    const result = await waitForReview(HEAD, {
      fetchReview: async () => pr1,
      readHead: async () => HEAD,
      now: () => 0,
      sleep: async () => {},
    });
    expect(result.state).toBe("complete");
  });

  describe("saveCommentFeeds", () => {
    const qodo = (at: string) => ({ user: { login: "qodo-code-review[bot]" }, updated_at: at });
    const page = (...items: unknown[]) => JSON.stringify([items]);

    it("saves the raw feeds before parsing, so a truncated answer is kept", () => {
      const writes: [string, string][] = [];
      const truncated = '[[{"user":{"login":"qodo';
      expect(() =>
        saveCommentFeeds({ pr: truncated, inline: "[[]]" }, "", (f, t) => writes.push([f, t]), "4950112"),
      ).toThrow();
      expect(writes).toHaveLength(1);
      expect(writes[0]?.[0]).toBe("4950112.comments.latest.raw.json");
      expect(JSON.parse(writes[0]?.[1] ?? "")).toEqual({ pr: truncated, inline: "[[]]" });
    });

    it("writes a new version only when the content changed", () => {
      const writes: string[] = [];
      const raw = { pr: page(qodo("2026-11-09T15:50:01Z")), inline: page() };
      const last = saveCommentFeeds(raw, "", (f) => writes.push(f), "4950112");
      saveCommentFeeds(raw, last, (f) => writes.push(f), "4950112");
      expect(writes.filter((f) => !f.includes("latest"))).toEqual(["4950112.comments.2026-11-09T155001Z.raw.json"]);
    });

    it("reads every page and both feeds for the newest Qodo version", () => {
      const writes: string[] = [];
      const raw = {
        pr: JSON.stringify([[qodo("2026-11-09T15:50:01Z")], [qodo("2026-11-09T15:52:00Z")]]),
        inline: page(qodo("2026-11-09T15:51:00Z"), { user: { login: "someone" }, updated_at: "2026-11-09T16:00:00Z" }),
      };
      saveCommentFeeds(raw, "", (f) => writes.push(f), "abc1234");
      expect(writes).toContain("abc1234.comments.2026-11-09T155200Z.raw.json");
    });

    it("saves a comment with a deleted author as 'unknown' instead of crashing, leaving real authors untouched", () => {
      const writes: [string, string][] = [];
      const withId = { user: { login: "someone", id: 42 }, updated_at: "2026-11-09T15:40:00Z" };
      const raw = {
        pr: JSON.stringify([
          [{ user: null, updated_at: "2026-11-09T15:40:00Z" }, qodo("2026-11-09T15:50:01Z"), withId],
        ]),
        inline: page(),
      };
      expect(() => saveCommentFeeds(raw, "", (f, t) => writes.push([f, t]), "deadbee")).not.toThrow();
      const versioned = writes.find(([f]) => f === "deadbee.comments.2026-11-09T155001Z.raw.json");
      expect(versioned?.[1]).toContain('"login":"unknown"');
      // A comment that does have an author keeps its full user object, not just the login.
      expect(versioned?.[1]).toContain('"user":{"login":"someone","id":42}');
    });
  });
});

describe("ciOrUnavailable", () => {
  it("summarizes the checks when the lookup succeeds", () => {
    expect(ciOrUnavailable(() => [{ name: "build", status: "completed", conclusion: "success" }])).toBe(
      "build: success",
    );
  });

  it("falls back to 'unavailable' without throwing when the lookup fails, and still reports why", () => {
    const errors: unknown[] = [];
    const ci = ciOrUnavailable(
      () => {
        throw new Error("gh: 502");
      },
      (error) => errors.push(error),
    );
    expect(ci).toBe("unavailable");
    expect(errors).toHaveLength(1);
  });
});

describe("summarizeCi", () => {
  it("joins check runs as one line", () => {
    expect(
      summarizeCi([
        { name: "build", status: "completed", conclusion: "success" },
        { name: "lint", status: "completed", conclusion: "failure" },
      ]),
    ).toBe("build: success, lint: failure");
  });

  it("falls back to status when there's no conclusion yet", () => {
    expect(summarizeCi([{ name: "build", status: "in_progress", conclusion: null }])).toBe("build: in_progress");
  });

  it("says 'no checks' when there are none", () => {
    expect(summarizeCi([])).toBe("no checks");
  });
});

describe("QodoApi: raw body kept before parsing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const stubRpc = (handlers: Record<string, () => Response>) => {
    vi.stubEnv("QODO_API_KEY", "test-key");
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body);
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected method ${method}`);
      return handler();
    });
  };

  const ok = (id: number, result: unknown) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200 });
  const started = { initialize: () => ok(1, {}), "notifications/initialized": () => new Response("", { status: 200 }) };

  it("keeps the successful response text itself as the raw answer", async () => {
    const body = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: '{"ok":true}' }] } };
    stubRpc({ ...started, "tools/call": () => new Response(JSON.stringify(body), { status: 200 }) });
    const api = new QodoApi();
    await expect(api.call("get-pr-review-findings")).resolves.toEqual({ ok: true });
    expect(api.lastRaw).toBe(JSON.stringify(body));
  });

  it("saves an unparseable 200 body with its HTTP status, instead of losing it", async () => {
    stubRpc({ ...started, "tools/call": () => new Response("not json", { status: 200 }) });
    const api = new QodoApi();
    await expect(api.call("get-pr-review-findings")).rejects.toThrow(/could not parse/);
    expect(JSON.parse(api.lastRaw)).toMatchObject({ httpStatus: 200, body: "not json" });
  });

  it("saves an HTTP error body next to the raw file, with its status", async () => {
    stubRpc({ ...started, "tools/call": () => new Response("server exploded", { status: 500 }) });
    const api = new QodoApi();
    await expect(api.call("get-pr-review-findings")).rejects.toThrow(/HTTP 500/);
    expect(JSON.parse(api.lastRaw)).toEqual({ httpStatus: 500, body: "server exploded" });
  });
});

describe("QodoApi: recovers from a session Qodo later forgot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("starts a new session and retries once after a 404 (session not found)", async () => {
    vi.stubEnv("QODO_API_KEY", "test-key");
    let starts = 0;
    let toolCalls = 0;
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const { method, id } = JSON.parse(init.body);
      if (method === "initialize") {
        starts++;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {} }), {
          status: 200,
          headers: { "mcp-session-id": `session-${starts}` },
        });
      }
      if (method === "notifications/initialized") return new Response("", { status: 200 });
      if (method === "tools/call") {
        toolCalls++;
        if (toolCalls === 1) return new Response("no such session", { status: 404 });
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: '{"ok":true}' }] } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method ${method}`);
    });
    const api = new QodoApi();
    await expect(api.call("get-pr-review-findings")).resolves.toEqual({ ok: true });
    expect(starts).toBe(2);
    expect(toolCalls).toBe(2);
    // The retry's own answer overwrites lastRaw; the 404 that caused it is kept too, not lost.
    expect(api.lastRecoveredRaw).toEqual([JSON.stringify({ httpStatus: 404, body: "no such session" })]);
    expect(api.lastRaw).not.toBe(api.lastRecoveredRaw[0]);
  });

  it("starts a new session and retries once after a JSON-RPC error naming the session", async () => {
    vi.stubEnv("QODO_API_KEY", "test-key");
    let starts = 0;
    let toolCalls = 0;
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const { method, id } = JSON.parse(init.body);
      if (method === "initialize") {
        starts++;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {} }), {
          status: 200,
          headers: { "mcp-session-id": `session-${starts}` },
        });
      }
      if (method === "notifications/initialized") return new Response("", { status: 200 });
      if (method === "tools/call") {
        toolCalls++;
        if (toolCalls === 1) {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Session not found" } }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: '{"ok":true}' }] } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method ${method}`);
    });
    const api = new QodoApi();
    await expect(api.call("get-pr-review-findings")).resolves.toEqual({ ok: true });
    expect(starts).toBe(2);
  });

  it("doesn't retry a plain tool error once a session is established", async () => {
    vi.stubEnv("QODO_API_KEY", "test-key");
    let starts = 0;
    let toolCalls = 0;
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const { method, id } = JSON.parse(init.body);
      if (method === "initialize") {
        starts++;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {} }), {
          status: 200,
          headers: { "mcp-session-id": "session-1" },
        });
      }
      if (method === "notifications/initialized") return new Response("", { status: 200 });
      if (method === "tools/call") {
        toolCalls++;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message: "bad request" } }), {
          status: 200,
        });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const api = new QodoApi();
    await expect(api.call("get-pr-review-findings")).rejects.toThrow("bad request");
    expect(starts).toBe(1);
    expect(toolCalls).toBe(1);
  });

  it("doesn't retry Qodo's own tool-level answer, even one whose text happens to mention a session", async () => {
    vi.stubEnv("QODO_API_KEY", "test-key");
    let starts = 0;
    let toolCalls = 0;
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const { method, id } = JSON.parse(init.body);
      if (method === "initialize") {
        starts++;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {} }), {
          status: 200,
          headers: { "mcp-session-id": "session-1" },
        });
      }
      if (method === "notifications/initialized") return new Response("", { status: 200 });
      if (method === "tools/call") {
        toolCalls++;
        // A successful call whose tool-level answer is itself an error (isError), not a transport
        // failure: its text mentioning "session" must not be read as the connection being lost.
        const body = {
          jsonrpc: "2.0",
          id,
          result: { isError: true, content: [{ type: "text", text: "no review session for that commit" }] },
        };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const api = new QodoApi();
    await expect(api.call("get-pr-review-findings")).rejects.toThrow(/no review session/);
    expect(starts).toBe(1);
    expect(toolCalls).toBe(1);
  });
});

describe("reviewState: a skip belongs to one commit (#188)", () => {
  const HEAD = "a".repeat(40);
  const OLDER = "b".repeat(40);
  const session = { commit_sha: HEAD, status: "completed", review_complete: false };

  it("is running, not skipped, when only an earlier commit's run was skipped", () => {
    const review = {
      review_session: session,
      review_runs: [
        { commit_sha: OLDER, run_id: 1, review_effort: "skip", status: "completed" },
        { commit_sha: HEAD, run_id: 2, review_effort: "standard", status: "completed" },
      ],
    } as QodoReview;
    expect(reviewState(review, HEAD)).toBe("running");
  });

  it("is skipped when the head commit's own run was skipped, wherever it sits in the list", () => {
    const review = {
      review_session: session,
      review_runs: [
        { commit_sha: OLDER, run_id: 1, review_effort: "standard", status: "completed" },
        { commit_sha: HEAD, run_id: 2, review_effort: "skip", status: "completed" },
      ],
    } as QodoReview;
    expect(reviewState(review, HEAD)).toBe("skipped");
  });
});

describe("findingsShapeProblem: a complete review must hold a readable findings list (#196)", () => {
  it("accepts the saved fixture as it is", () => {
    expect(findingsShapeProblem(pr1)).toBeUndefined();
  });

  it("refuses a review with no findings list, rather than read it as zero findings", () => {
    const { findings: _gone, ...rest } = pr1;
    expect(findingsShapeProblem(rest)).toMatch(/no findings list/);
    expect(findingsShapeProblem({ ...pr1, findings: { renamed: [] } as never })).toMatch(/no findings list/);
  });

  it("refuses a review whose count disagrees with its list", () => {
    expect(findingsShapeProblem({ ...pr1, finding_count: (pr1.findings?.length ?? 0) + 1 })).toMatch(/counts \d+/);
    expect(findingsShapeProblem({ ...pr1, finding_count: pr1.findings?.length ?? 0 })).toBeUndefined();
  });
});

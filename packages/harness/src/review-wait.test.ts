import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evidenceDir } from "./paths.ts";
import { isSessionLost, parseRpcBody, parseToolText, QodoApi, TransportError } from "./qodo-api.ts";
import {
  findingsFor,
  findingsShapeProblem,
  openFindings,
  type QodoReview,
  reviewEffort,
  reviewState,
} from "./qodo-review.ts";
import { ciOrUnavailable, saveCommentFeeds, summarizeCi } from "./review-feeds.ts";
import { sameCommit, waitForHead, waitForReview } from "./review-poll.ts";
import { liveDeps, main, parseArgs, run, type WaitScriptDeps } from "./review-wait-run.ts";
import { archiveUnfinished, writeSavedReview } from "./saved-review.ts";

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

  it("refuses runs that aren't a list of runs, or a session that isn't an object, instead of throwing (Qodo on PR 286)", () => {
    for (const review_runs of [{}, "x", [null], [1], [[]]]) {
      expect(findingsShapeProblem({ ...pr1, review_runs: review_runs as never }, PR1_HEAD)).toMatch(/list of runs/);
    }
    // A run still being filled in, with no commit yet, or no runs at all, is read as before (Qodo on PR 286).
    const runs = [...(pr1.review_runs ?? []), { review_effort: "standard" }];
    expect(findingsShapeProblem({ ...pr1, review_runs: runs as never }, PR1_HEAD)).toBeUndefined();
    expect(findingsShapeProblem({ ...pr1, review_runs: null as never }, PR1_HEAD)).toBeUndefined();
    expect(findingsShapeProblem({ ...pr1, review_session: [] as never })).toMatch(/isn't an object/);
    expect(findingsShapeProblem({ ...pr1, review_session: "done" as never })).toMatch(/isn't an object/);
  });
});

describe("findingsShapeProblem: every finding is read field by field (AUD-M9, #249)", () => {
  const onlyFinding = pr1.findings?.find((f) => f.git_sha === PR1_HEAD) as NonNullable<QodoReview["findings"]>[0];
  const withFinding = (change: Record<string, unknown>): QodoReview => ({
    ...pr1,
    findings: [{ ...onlyFinding, ...change } as never],
    finding_count: 1,
  });

  it("accepts the real answer for its head", () => {
    expect(findingsShapeProblem(pr1, PR1_HEAD)).toBeUndefined();
  });

  it("refuses an abbreviated or upper-case SHA, rather than drop the finding", () => {
    expect(findingsShapeProblem(withFinding({ git_sha: PR1_HEAD.slice(0, 7) }), PR1_HEAD)).toMatch(
      /not a full lower-case commit id/,
    );
    expect(findingsShapeProblem(withFinding({ git_sha: PR1_HEAD.toUpperCase() }), PR1_HEAD)).toMatch(
      /not a full lower-case commit id/,
    );
  });

  it("refuses a finding with only one of its lines, string lines, or a renamed file field", () => {
    expect(findingsShapeProblem(withFinding({ end_line: undefined }), PR1_HEAD)).toMatch(/not a line range/);
    expect(findingsShapeProblem(withFinding({ start_line: "33", end_line: "33" }), PR1_HEAD)).toMatch(
      /not a line range/,
    );
    expect(findingsShapeProblem(withFinding({ file_path: undefined, path: "src/x.ts" }), PR1_HEAD)).toMatch(
      /no file_path/,
    );
  });

  it("accepts a finding Qodo placed nowhere, with both lines and the file null", () => {
    expect(
      findingsShapeProblem(withFinding({ file_path: null, start_line: null, end_line: null }), PR1_HEAD),
    ).toBeUndefined();
  });

  it("accepts findings on an earlier commit Qodo reviewed, but not on commits it reports no run for", () => {
    const earlier = "e".repeat(40);
    const twoRounds: QodoReview = {
      ...withFinding({ git_sha: earlier }),
      review_runs: [...(pr1.review_runs ?? []), { commit_sha: earlier, review_effort: "standard" }],
    };
    expect(findingsShapeProblem(twoRounds, PR1_HEAD)).toBeUndefined();
    expect(findingsShapeProblem(withFinding({ git_sha: earlier }), PR1_HEAD)).toMatch(/none on/);
  });
});

describe("reviewState: a skip wins, and only true is complete (AUD-N8)", () => {
  const session = { commit_sha: PR1_HEAD, status: "completed" };
  it("is skipped when the head's run was skipped, even if Qodo also marks it complete", () => {
    const review = {
      review_session: { ...session, review_complete: true },
      review_runs: [{ commit_sha: PR1_HEAD, review_effort: "skip" }],
    };
    expect(reviewState(review, PR1_HEAD)).toBe("skipped");
  });

  it("isn't complete when review_complete is a string", () => {
    expect(reviewState({ review_session: { ...session, review_complete: "true" as never } }, PR1_HEAD)).toBe("running");
  });
});

describe("sameCommit (M68)", () => {
  it("needs at least seven characters of the commit", () => {
    expect(sameCommit(PR1_HEAD, PR1_HEAD.slice(0, 7))).toBe(true);
    expect(sameCommit(PR1_HEAD, PR1_HEAD.slice(0, 6))).toBe(false);
  });
});

describe("run: what review:wait saves, and what it refuses (AUD-M6, AUD-M26, #252)", () => {
  /** Fake GitHub and Qodo: the head is `PR1_HEAD`, and Qodo answers each of `answers` in turn. */
  function harness(answers: unknown[]) {
    const dir = join(mkdtempSync(join(tmpdir(), "review-wait-")), "target-pr1");
    let t = Date.parse("2026-11-14T00:00:00.000Z");
    let i = 0;
    const out: string[] = [];
    const err: string[] = [];
    let fetches = 0;
    const deps: WaitScriptDeps = {
      github: "Owner/target",
      dir,
      readHead: async () => PR1_HEAD,
      checkSuiteTimes: () => ["2026-11-13T23:59:00Z"],
      commentFeeds: () => ({ pr: "[[]]", inline: "[[]]" }),
      formalReviews: () => "[]",
      fetchReview: async () => {
        fetches++;
        return answers[Math.min(i++, answers.length - 1)];
      },
      rawAnswers: () => ({ last: "raw", recovered: [] }),
      checkRuns: () => [],
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      log: (l) => out.push(l),
      error: (l) => err.push(l),
    };
    const wait = (commit: string | null = PR1_HEAD) =>
      run({ repoKey: "target", pr: 1, timeoutMinutes: 1, commit }, deps);
    const saved = () => JSON.parse(readFileSync(join(dir, `${PR1_HEAD.slice(0, 7)}.review.json`), "utf8"));
    return { dir, wait, saved, out, err, fetches: () => fetches };
  }

  const running = { review_session: { commit_sha: PR1_HEAD, status: "running" } };
  const skipped = {
    review_session: { commit_sha: PR1_HEAD, status: "completed", review_complete: false },
    review_runs: [{ commit_sha: PR1_HEAD, review_effort: "skip" }],
    findings: [],
  };

  it("saves a complete review as complete, with its findings, and exits 0", async () => {
    const h = harness([pr1]);
    expect(await h.wait()).toBe(0);
    expect(h.saved()).toMatchObject({ state: "complete", headSha: PR1_HEAD, findings: [{ lines: [33, 33] }] });
  });

  it("saves a timeout as review incomplete, never complete, and exits 1", async () => {
    const h = harness([running]);
    expect(await h.wait()).toBe(1);
    expect(h.saved().state).toBe("review incomplete");
    expect(h.saved().reviewSeenCompleteAt).toBeNull();
  });

  it("saves a skip as skipped by Qodo, never complete, and exits 3", async () => {
    const h = harness([skipped]);
    expect(await h.wait()).toBe(3);
    expect(h.saved().state).toBe("skipped by Qodo");
  });

  it("refuses, exit 2, a complete review it can't read, and saves no review (M21)", async () => {
    const h = harness([{ ...pr1, findings: pr1.findings?.map((f) => ({ ...f, git_sha: f.git_sha.slice(0, 7) })) }]);
    expect(await h.wait()).toBe(2);
    expect(h.err.join("\n")).toContain("not a full lower-case commit id");
    expect(() => h.saved()).toThrow();
  });

  it("exits 2, not 1, when Qodo answers null or text on every poll", async () => {
    const h = harness([null, "busy"]);
    expect(await h.wait()).toBe(2);
    expect(h.err.join("\n")).toContain("not a review");
  });

  it("refuses, exit 2, to wait again for a commit it saved complete, and leaves the save as it was", async () => {
    const h = harness([pr1]);
    mkdirSync(h.dir, { recursive: true });
    const path = join(h.dir, `${PR1_HEAD.slice(0, 7)}.review.json`);
    writeFileSync(path, '{"state":"complete"}');
    expect(await h.wait()).toBe(2);
    expect(await h.wait(null)).toBe(2);
    expect(h.err.join("\n")).toContain("is never overwritten");
    expect(readFileSync(path, "utf8")).toBe('{"state":"complete"}');
    expect(h.fetches()).toBe(0);
  });

  it("waits again after an unfinished save, and keeps that save under another name (Qodo on PR 264)", async () => {
    const h = harness([pr1]);
    mkdirSync(h.dir, { recursive: true });
    writeFileSync(join(h.dir, `${PR1_HEAD.slice(0, 7)}.review.json`), '{"state":"review incomplete"}');
    expect(await h.wait()).toBe(0);
    expect(h.saved().state).toBe("complete");
    const kept = join(h.dir, `${PR1_HEAD.slice(0, 7)}.unfinished-1`, `${PR1_HEAD.slice(0, 7)}.review.json`);
    expect(readFileSync(kept, "utf8")).toBe('{"state":"review incomplete"}');
  });
});

describe("writeSavedReview", () => {
  it("never writes over a complete save", () => {
    const path = join(mkdtempSync(join(tmpdir(), "saved-review-")), "abc1234.review.json");
    writeSavedReview(path, { state: "complete" });
    expect(() => writeSavedReview(path, { state: "review incomplete" })).toThrow(/never overwritten/);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ state: "complete" });
  });

  it("keeps each unfinished save it follows, numbered", () => {
    const dir = mkdtempSync(join(tmpdir(), "saved-review-"));
    const path = join(dir, "abc1234.review.json");
    writeSavedReview(path, { state: "review incomplete", n: 1 });
    writeSavedReview(path, { state: "skipped by Qodo", n: 2 });
    writeSavedReview(path, { state: "complete", n: 3 });
    expect(JSON.parse(readFileSync(join(dir, "abc1234.unfinished-1.json"), "utf8")).n).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "abc1234.unfinished-2.json"), "utf8")).n).toBe(2);
    expect(JSON.parse(readFileSync(path, "utf8")).n).toBe(3);
  });
});

describe("run: waiting again after an unfinished save keeps all its evidence (Qodo on PR 264)", () => {
  it("moves the save and every raw file of the commit into a folder of their own", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "review-wait-")), "target-pr1");
    mkdirSync(dir, { recursive: true });
    const short = PR1_HEAD.slice(0, 7);
    writeFileSync(join(dir, `${short}.review.json`), '{"state":"review incomplete"}');
    writeFileSync(join(dir, `${short}.qodo-api.raw.json`), "old answer");
    writeFileSync(join(dir, "other.review.json"), "another commit");
    const kept = archiveUnfinished(dir, PR1_HEAD);
    expect(kept).toBe(join(dir, `${short}.unfinished-1`));
    expect(readFileSync(join(dir, `${short}.unfinished-1`, `${short}.qodo-api.raw.json`), "utf8")).toBe("old answer");
    expect(readdirSync(dir).sort()).toEqual([`${short}.unfinished-1`, "other.review.json"]);
    expect(archiveUnfinished(dir, PR1_HEAD)).toBeUndefined();
  });

  it("writes its saves under its own checkout, whatever FAULTFORGE_PRIVATE_DIR says", () => {
    const before = process.env.FAULTFORGE_PRIVATE_DIR;
    process.env.FAULTFORGE_PRIVATE_DIR = mkdtempSync(join(tmpdir(), "elsewhere-"));
    try {
      expect(liveDeps("faultforge", 1).dir).toBe(join(evidenceDir(), "reviews", "faultforge-pr1"));
    } finally {
      if (before === undefined) delete process.env.FAULTFORGE_PRIVATE_DIR;
      else process.env.FAULTFORGE_PRIVATE_DIR = before;
    }
  });
});

describe("main: the command line (#252)", () => {
  it("reads a usage problem as could not run, 2", async () => {
    expect(await main(["target"])).toBe(2);
    expect(await main(["target", "0"])).toBe(2);
  });
});

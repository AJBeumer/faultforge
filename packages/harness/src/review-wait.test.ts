import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRpcBody, parseToolText } from "./qodo-api.ts";
import { findingsFor, openFindings, type QodoReview, reviewEffort, reviewState, waitForReview } from "./review-wait.ts";

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

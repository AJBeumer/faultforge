/**
 * A wait's time limit bounds its gh calls (Qodo on PR 310): with `callDeadline` set, a call's own time limit is cut
 * to what is left, a read is not tried again past it, and review:wait sets it for its waiting and clears it before
 * it saves its evidence. gh itself is stubbed.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

import { execFileSync } from "node:child_process";
import { CALL_TIMEOUT_MS, callDeadline, gh, readRetry } from "./github.ts";
import { run, type WaitScriptDeps } from "./review-wait-run.ts";

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
  callDeadline.at = undefined;
});
const timeoutOf = (call = 0) =>
  (vi.mocked(execFileSync).mock.calls[call]?.[2] as { timeout?: number } | undefined)?.timeout ?? -1;

describe("gh under a deadline (Qodo on PR 310)", () => {
  it("keeps the shared time limit when no deadline is set", () => {
    vi.mocked(execFileSync).mockReturnValue("{}");
    gh("api", "repos/o/r");
    expect(timeoutOf()).toBe(CALL_TIMEOUT_MS);
  });

  it("cuts a call's time limit to what is left before the deadline", () => {
    vi.mocked(execFileSync).mockReturnValue("{}");
    callDeadline.at = Date.now() + 5_000;
    gh("api", "repos/o/r");
    expect(timeoutOf()).toBeGreaterThan(0);
    expect(timeoutOf()).toBeLessThanOrEqual(5_000);
  });

  it("starts no call once the deadline has passed, and says it timed out", () => {
    callDeadline.at = Date.now() - 1;
    expect(() => gh("api", "repos/o/r")).toThrow(/timed out/);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it("doesn't try a read again when the pause would end past the deadline", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw { stderr: "gh: HTTP 502: Bad Gateway\n" };
    });
    callDeadline.at = Date.now() + readRetry.baseMs / 2;
    expect(() => gh("api", "repos/o/r")).toThrow(/HTTP 502/);
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(1);
    expect(pauses).toEqual([]);
  });
});

describe("review:wait bounds its gh calls by its own time limit (Qodo on PR 310)", () => {
  it("sets the deadline while it waits and clears it before it saves", async () => {
    const seen: { during?: number; saving?: number } = {};
    const head = "a".repeat(40);
    let t = Date.now();
    const deps: WaitScriptDeps = {
      github: "Owner/target",
      dir: join(mkdtempSync(join(tmpdir(), "review-deadline-")), "target-pr1"),
      readHead: async () => {
        seen.during ??= callDeadline.at;
        return head;
      },
      checkSuiteTimes: () => [],
      commentFeeds: () => ({ pr: "[[]]", inline: "[[]]" }),
      formalReviews: () => "[]",
      fetchReview: async () => ({ review_session: { commit_sha: head, status: "running" } }),
      rawAnswers: () => ({ last: "raw", recovered: [] }),
      checkRuns: () => {
        seen.saving = callDeadline.at;
        return [];
      },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      log: () => {},
      error: () => {},
    };
    const before = Date.now();
    expect(await run({ repoKey: "target", pr: 1, timeoutMinutes: 1, commit: head }, deps)).toBe(1);
    expect(seen.during).toBeGreaterThanOrEqual(before + 60_000);
    expect(seen.during).toBeLessThanOrEqual(Date.now() + 60_000 + CALL_TIMEOUT_MS);
    expect(seen.saving).toBeUndefined();
    expect(callDeadline.at).toBeUndefined();
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LocalReviewPayload } from "./local-findings.ts";
import { type ReviewLocalDeps, runReviewLocal } from "./local-review-run.ts";
import type { OperationState, ResultChunkPage, StartParams } from "./local-review-wire.ts";
import { parseArgs, removeWorktree } from "./review-local.ts";

describe("parseArgs", () => {
  it("reads the repo key, --isolated and --timeout", () => {
    expect(parseArgs(["faultforge", "--isolated", "--timeout", "5"])).toEqual({
      repoKey: "faultforge",
      isolated: true,
      timeoutMinutes: 5,
    });
  });

  it("defaults isolated to false and the timeout to 20 minutes", () => {
    expect(parseArgs(["target"])).toEqual({ repoKey: "target", isolated: false, timeoutMinutes: 20 });
  });

  it("is null with no repo key, or a non-numeric timeout", () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(["faultforge", "--timeout", "soon"])).toBeNull();
  });
});

describe("runReviewLocal", () => {
  const baseStartParams = (): StartParams => ({
    repo_full_name: "AJBeumer/faultforge",
    base_sha: "a".repeat(40),
    diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    review_scope: { stream_id: "f".repeat(64), paths: [], complete: true, excluded_files: [], skipped_files: [] },
  });

  function baseOperation(overrides: Partial<OperationState> = {}): OperationState {
    return {
      operation_id: "op-1",
      status: "working",
      terminal: false,
      result_available: false,
      poll_interval_seconds: 0,
      ...overrides,
    };
  }

  function completedOperation(overrides: Partial<OperationState> = {}): OperationState {
    return baseOperation({ status: "completed", terminal: true, result_available: true, ...overrides });
  }

  /** Wraps a review payload the way Qodo's own managed-agent envelope does (confirmed live, 12
   * November): `{output: "<json>"}` where that json is `{result: payload, status}`. */
  function chunkPayload(payload: LocalReviewPayload): ResultChunkPage {
    const text = JSON.stringify({ output: JSON.stringify({ result: payload, status: "completed" }) });
    return { chunk: text, next_cursor: null, sha256: createHash("sha256").update(text, "utf8").digest("hex") };
  }

  const completePayload = (overrides: Partial<LocalReviewPayload> = {}): LocalReviewPayload => ({
    findings: [],
    finding_state: { complete: true, introduced: [], still_open: [], resolved: [], dismissed: [] },
    meta: { coverage: { complete: true }, run: { effort: { effective: "standard" } } },
    ...overrides,
  });

  function makeDeps(overrides: Partial<ReviewLocalDeps> = {}): ReviewLocalDeps {
    return {
      startParams: baseStartParams(),
      submit: async () => completedOperation(),
      poll: async () => completedOperation(),
      fetchResultChunk: async () => chunkPayload(completePayload()),
      sleep: async () => {},
      now: () => 0,
      newRequestId: () => "req-1",
      saveArtifact: () => {},
      ...overrides,
    };
  }

  it("never runs when there are no uncommitted changes to review", async () => {
    const result = await runReviewLocal(makeDeps({ startParams: { ...baseStartParams(), diff: "" } }), {
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ exitCode: 2, operationId: null });
  });

  it("is clean (exit 0) when nothing open is action-required", async () => {
    const payload = completePayload({
      findings: [
        {
          id: "f1",
          title: "A nit",
          category: "Observability",
          action_level: "remediation_recommended",
          diff_reference: { file_path: "a.ts", start_line: 1, end_line: 1 },
        },
      ],
      finding_state: {
        complete: true,
        introduced: [{ id: "f1" }],
        still_open: [],
        resolved: [],
        dismissed: [],
      },
    });
    const result = await runReviewLocal(makeDeps({ fetchResultChunk: async () => chunkPayload(payload) }), {
      timeoutMs: 1000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.findings).toHaveLength(1);
  });

  it("is exit 1 when an open finding is action-required", async () => {
    const payload = completePayload({
      findings: [
        {
          id: "f1",
          title: "Real bug",
          category: "Correctness",
          action_level: "action_required",
          diff_reference: { file_path: "a.ts", start_line: 1, end_line: 1 },
        },
      ],
      finding_state: { complete: true, introduced: [{ id: "f1" }], still_open: [], resolved: [], dismissed: [] },
    });
    const result = await runReviewLocal(makeDeps({ fetchResultChunk: async () => chunkPayload(payload) }), {
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.findings[0]).toMatchObject({ label: "new", open: true });
  });

  it("is exit 3, never 0, when Qodo skipped the review", async () => {
    const payload = completePayload({ meta: { coverage: { complete: true }, run: { effort: { effective: "skip" } } } });
    const result = await runReviewLocal(makeDeps({ fetchResultChunk: async () => chunkPayload(payload) }), {
      timeoutMs: 1000,
    });
    expect(result.exitCode).toBe(3);
  });

  it("is exit 3, never 0, when Qodo's coverage was incomplete", async () => {
    const payload = completePayload({
      meta: { coverage: { complete: false }, run: { effort: { effective: "standard" } } },
    });
    const result = await runReviewLocal(makeDeps({ fetchResultChunk: async () => chunkPayload(payload) }), {
      timeoutMs: 1000,
    });
    expect(result.exitCode).toBe(3);
  });

  it("counts a finding listed both open and resolved as open, so a blocker can't hide (Qodo on PR 209)", async () => {
    const finding = { id: "f1", action_level: "action_required", title: "Both" };
    const payload = completePayload({
      findings: [finding] as never,
      finding_state: {
        complete: true,
        introduced: [],
        still_open: [finding],
        resolved: [finding],
        dismissed: [],
      } as never,
    });
    const result = await runReviewLocal(makeDeps({ fetchResultChunk: async () => chunkPayload(payload) }), {
      timeoutMs: 1000,
    });
    expect(result.exitCode).toBe(1);
  });

  it("is exit 3, not a crash, when a state list holds null or isn't a list (Qodo on PR 209)", async () => {
    for (const finding_state of [
      { complete: true, introduced: [], still_open: [], resolved: [null], dismissed: [] },
      { complete: true, introduced: "f1", still_open: [], resolved: [], dismissed: [] },
    ]) {
      const payload = completePayload({ finding_state: finding_state as never });
      const result = await runReviewLocal(makeDeps({ fetchResultChunk: async () => chunkPayload(payload) }), {
        timeoutMs: 1000,
      });
      expect(result.exitCode).toBe(3);
    }
  });

  it("retries a poll that fails once and finishes the review (#196)", async () => {
    let polls = 0;
    const result = await runReviewLocal(
      makeDeps({
        submit: async () => baseOperation(),
        poll: async () => {
          polls++;
          if (polls === 1) throw new Error("HTTP 502");
          return completedOperation();
        },
      }),
      { timeoutMs: 600_000 },
    );
    expect(polls).toBe(2);
    expect(result.exitCode).toBe(0);
  });

  it("waits a bounded interval when Qodo gives none or zero, so it never loops hot or forever (#196)", async () => {
    for (const interval of [undefined, 0, -3, 1_000]) {
      let now = 0;
      const waits: number[] = [];
      let cancelled = false;
      const result = await runReviewLocal(
        makeDeps({
          submit: async () => baseOperation({ poll_interval_seconds: interval as never }),
          poll: async () => baseOperation({ poll_interval_seconds: interval as never }),
          sleep: async (ms) => {
            waits.push(ms);
            now += ms;
          },
          now: () => now,
          cancel: async () => {
            cancelled = true;
          },
        }),
        { timeoutMs: 120_000 },
      );
      expect(result.exitCode).toBe(2);
      expect(waits.every((ms) => ms >= 1_000 && ms <= 60_000)).toBe(true);
      expect(waits.length).toBeLessThanOrEqual(120);
      expect(cancelled).toBe(true);
    }
  });

  it("cancels the operation when every poll fails until the deadline, naming the last error (#196)", async () => {
    let now = 0;
    let cancelled = false;
    const result = await runReviewLocal(
      makeDeps({
        submit: async () => baseOperation({ poll_interval_seconds: 5 }),
        poll: async () => {
          throw new Error("fetch timed out");
        },
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
        cancel: async () => {
          cancelled = true;
        },
      }),
      { timeoutMs: 30_000 },
    );
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("fetch timed out");
    expect(cancelled).toBe(true);
  });

  it("counts a finding no state list names as open, and is exit 3 when a list holds bare ids (#196)", async () => {
    const finding = { id: "f9", action_level: "action_required", title: "Unlisted" };
    const unlisted = completePayload({ findings: [finding] as never });
    const listed = await runReviewLocal(makeDeps({ fetchResultChunk: async () => chunkPayload(unlisted) }), {
      timeoutMs: 1000,
    });
    expect(listed.exitCode).toBe(1);
    expect(listed.findings[0]).toMatchObject({ id: "f9", open: true });

    const bareIds = completePayload({
      findings: [finding] as never,
      finding_state: { complete: true, introduced: ["f9"], still_open: [], resolved: [], dismissed: [] } as never,
    });
    const shape = await runReviewLocal(makeDeps({ fetchResultChunk: async () => chunkPayload(bareIds) }), {
      timeoutMs: 1000,
    });
    expect(shape.exitCode).toBe(3);
  });

  it("is exit 3, never 0, when the result omits its finding inventory, not just when it says false (#188)", async () => {
    const { finding_state: _omitted, ...withoutState } = completePayload();
    const withoutFlag = completePayload({
      finding_state: { introduced: [], still_open: [], resolved: [], dismissed: [] } as never,
    });
    for (const payload of [withoutState as LocalReviewPayload, withoutFlag]) {
      const result = await runReviewLocal(makeDeps({ fetchResultChunk: async () => chunkPayload(payload) }), {
        timeoutMs: 1000,
      });
      expect(result.exitCode).toBe(3);
      expect(result.message).toMatch(/finding inventory/);
    }
  });

  it("is exit 3, never 0, when the result omits coverage entirely, not just when it says false", async () => {
    const payload = completePayload({ meta: { run: { effort: { effective: "standard" } } } });
    const result = await runReviewLocal(makeDeps({ fetchResultChunk: async () => chunkPayload(payload) }), {
      timeoutMs: 1000,
    });
    expect(result.exitCode).toBe(3);
  });

  it("is exit 3, never 0 or 1, when Qodo did not report its finding inventory as complete", async () => {
    // Real answer from this command's own first live run, 12 November: `finding_state.complete` was
    // `false` while `meta.coverage.complete` was `true`, and there was an open action-required finding.
    const payload = completePayload({
      findings: [
        {
          id: "f1",
          title: "Real bug",
          category: "Correctness",
          action_level: "action_required",
          diff_reference: { file_path: "a.ts", start_line: 1, end_line: 1 },
        },
      ],
      finding_state: { complete: false, introduced: [{ id: "f1" }], still_open: [], resolved: [], dismissed: [] },
    });
    const result = await runReviewLocal(makeDeps({ fetchResultChunk: async () => chunkPayload(payload) }), {
      timeoutMs: 1000,
    });
    expect(result.exitCode).toBe(3);
  });

  it("is exit 3 when the local snapshot itself was incomplete, even with a clean payload", async () => {
    const incompleteScope = {
      ...baseStartParams(),
      review_scope: { ...baseStartParams().review_scope, complete: false },
    };
    const result = await runReviewLocal(makeDeps({ startParams: incompleteScope }), { timeoutMs: 1000 });
    expect(result.exitCode).toBe(3);
  });

  it("is exit 2 when Qodo reports the operation failed", async () => {
    const result = await runReviewLocal(
      makeDeps({
        submit: async () => baseOperation(),
        poll: async () => baseOperation({ status: "failed", terminal: true, error: { code: "x", message: "boom" } }),
      }),
      { timeoutMs: 10_000 },
    );
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("boom");
  });

  it("is exit 2 when the operation never finishes within the time limit, and tries to cancel it", async () => {
    let t = 0;
    const cancelled: string[] = [];
    const working = baseOperation({ poll_interval_seconds: 100 });
    const result = await runReviewLocal(
      makeDeps({
        submit: async () => working,
        poll: async () => working,
        cancel: async (operationId) => {
          cancelled.push(operationId);
        },
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      }),
      { timeoutMs: 1_000 },
    );
    expect(result.exitCode).toBe(2);
    expect(cancelled).toEqual(["op-1"]);
  });

  it("is exit 2 when the reconstructed result's hash doesn't match what Qodo reported", async () => {
    const result = await runReviewLocal(
      makeDeps({ fetchResultChunk: async () => ({ chunk: "{}", next_cursor: null, sha256: "0".repeat(64) }) }),
      { timeoutMs: 1000 },
    );
    expect(result.exitCode).toBe(2);
  });

  it("is exit 2 when no page ever supplies a checksum, instead of skipping verification", async () => {
    const result = await runReviewLocal(
      makeDeps({ fetchResultChunk: async () => ({ chunk: "{}", next_cursor: null }) }),
      { timeoutMs: 1000 },
    );
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("checksum");
  });

  it("is exit 2 when the result cursor repeats, instead of fetching forever", async () => {
    let calls = 0;
    const result = await runReviewLocal(
      makeDeps({
        fetchResultChunk: async () => {
          calls++;
          return { chunk: "", next_cursor: "same", sha256: "0".repeat(64) };
        },
      }),
      { timeoutMs: 10_000 },
    );
    expect(result.exitCode).toBe(2);
    expect(calls).toBe(2);
  });

  it("is exit 2 when a single fetch itself runs past the deadline, not only when the deadline passed before it started", async () => {
    let t = 0;
    const result = await runReviewLocal(
      makeDeps({
        fetchResultChunk: async () => {
          t += 10_000; // the request itself takes longer than the time budget below
          return { chunk: "{}", next_cursor: null, sha256: "0".repeat(64) };
        },
        now: () => t,
      }),
      { timeoutMs: 1_000 },
    );
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("time limit");
  });

  it("concatenates every chunk, in cursor order, before parsing", async () => {
    const payload = completePayload();
    const text = JSON.stringify({ output: JSON.stringify({ result: payload, status: "completed" }) });
    const half = Math.ceil(text.length / 2);
    const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
    const seenCursors: (string | null)[] = [];
    const result = await runReviewLocal(
      makeDeps({
        fetchResultChunk: async (_operationId, cursor) => {
          seenCursors.push(cursor);
          if (cursor === null) return { chunk: text.slice(0, half), next_cursor: "c2", sha256 };
          return { chunk: text.slice(half), next_cursor: null, sha256 };
        },
      }),
      { timeoutMs: 1000 },
    );
    expect(seenCursors).toEqual([null, "c2"]);
    expect(result.exitCode).toBe(0);
  });

  it("records the Qodo operation id next to our own request id, so an auditor can find the folder", async () => {
    const saved: Record<string, string> = {};
    await runReviewLocal(
      makeDeps({
        saveArtifact: (name, data) => {
          saved[name] = data;
        },
      }),
      { timeoutMs: 1000 },
    );
    expect(JSON.parse(saved["operation.json"] ?? "{}")).toEqual({ requestId: "req-1", operationId: "op-1" });
  });
});

describe("removeWorktree", () => {
  it("removes the folder only after git has unregistered the worktree", () => {
    const calls: string[] = [];
    const gone = removeWorktree(
      "/repo",
      "/tmp/p/worktree",
      "/tmp/p",
      (_root, args) => calls.push(`git ${args.join(" ")}`),
      (path) => calls.push(`rm ${path}`),
      () => {},
    );
    expect(gone).toBe(true);
    expect(calls).toEqual(["git worktree remove --force /tmp/p/worktree", "rm /tmp/p"]);
  });

  it("keeps the folder and says how to remove it when git fails, instead of orphaning the registration", () => {
    const calls: string[] = [];
    const reports: string[] = [];
    const gone = removeWorktree(
      "/repo",
      "/tmp/p/worktree",
      "/tmp/p",
      () => {
        throw new Error("locked");
      },
      (path) => calls.push(`rm ${path}`),
      (message) => reports.push(message),
    );
    expect(gone).toBe(false);
    expect(calls).toEqual([]);
    expect(reports[0]).toContain("worktree remove --force /tmp/p/worktree");
  });
});

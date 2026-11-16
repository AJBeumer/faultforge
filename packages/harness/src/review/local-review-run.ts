/**
 * The review loop behind `review:local`: submit, poll at Qodo's own interval, read the result back in
 * chunks, verify it and decide the exit code. Every call to Qodo is passed in, so it runs without a
 * network in the tests; `review-local.ts` wires it to the real API.
 */

import { sha256 } from "../shared/provenance.ts";
import { type LocalReviewPayload, labelFindings, stateListsReadable } from "./local-findings.ts";
import { type OperationState, type ResultChunkPage, type StartParams, unwrapResult } from "./local-review-wire.ts";

export interface ReviewLocalDeps {
  startParams: StartParams;
  submit: (requestId: string, params: StartParams) => Promise<OperationState>;
  poll: (operationId: string) => Promise<OperationState>;
  cancel?: (operationId: string) => Promise<void>;
  fetchResultChunk: (operationId: string, cursor: string | null) => Promise<ResultChunkPage>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  newRequestId: () => string;
  /** For the decoded payload; raw answers are saved by `callAndSaveRaw`. */
  saveArtifact: (name: string, data: string) => void;
}

export interface ReviewLocalResult {
  exitCode: 0 | 1 | 2 | 3;
  message: string;
  findings: ReturnType<typeof labelFindings>;
  operationId: string | null;
}

/** An endless `next_cursor` must never keep the command running past its time limit. */
const MAX_RESULT_PAGES = 1000;

/** Qodo's own interval, kept between 1 and 60 seconds, so a bad value can neither spin nor stall. */
export function pollIntervalMs(seconds: unknown): number {
  const n = typeof seconds === "number" ? seconds : Number.NaN;
  return (Number.isFinite(n) && n >= 0 ? Math.min(Math.max(n, 1), 60) : 5) * 1000;
}

/**
 * The exit code comes from the review's own state: never 0 or 1 when Qodo skipped the review or didn't
 * report it complete, however many findings came back.
 */
export async function runReviewLocal(deps: ReviewLocalDeps, opts: { timeoutMs: number }): Promise<ReviewLocalResult> {
  if (!deps.startParams.diff.trim()) {
    return { exitCode: 2, message: "no uncommitted changes to review", findings: [], operationId: null };
  }

  const deadline = deps.now() + opts.timeoutMs;
  const requestId = deps.newRequestId();
  let state = await deps.submit(requestId, deps.startParams);
  const operationId = state.operation_id;
  // The folder is named by our request id; this file lets someone holding Qodo's operation id find it.
  deps.saveArtifact(
    "operation.json",
    `${JSON.stringify({ requestId, operationId }, null, 2)}
`,
  );

  // One network error must not lose a review that takes minutes, so a failed poll is retried until the
  // deadline. Leaving without a finished operation, for any reason, cancels it.
  let lastPollError: string | null = null;
  try {
    while (!state.terminal) {
      const waitMs = pollIntervalMs(state.poll_interval_seconds);
      if (deps.now() + waitMs > deadline) {
        const why = lastPollError ? ` (last poll failed: ${lastPollError})` : "";
        return { exitCode: 2, message: `review did not finish within the time limit${why}`, findings: [], operationId };
      }
      await deps.sleep(waitMs);
      try {
        state = await deps.poll(operationId);
        lastPollError = null;
      } catch (error) {
        lastPollError = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
      }
    }
  } finally {
    if (!state.terminal && deps.cancel) {
      try {
        await deps.cancel(operationId);
      } catch {
        // Best-effort: the operation is reported as unfinished either way.
      }
    }
  }

  if (state.status !== "completed" || !state.result_available) {
    const why = state.error ? `: ${state.error.message}` : "";
    return { exitCode: 2, message: `Qodo reported the review as ${state.status}${why}`, findings: [], operationId };
  }

  let text = "";
  let cursor: string | null = null;
  let expectedSha256: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; ; page++) {
    if (deps.now() > deadline) {
      return { exitCode: 2, message: "fetching the review result exceeded the time limit", findings: [], operationId };
    }
    if (page >= MAX_RESULT_PAGES) {
      return {
        exitCode: 2,
        message: `the review result did not finish within ${MAX_RESULT_PAGES} pages`,
        findings: [],
        operationId,
      };
    }
    const chunk = await deps.fetchResultChunk(operationId, cursor);
    // Checked again: one fetch can take up to the transport's own timeout, well past the deadline.
    if (deps.now() > deadline) {
      return { exitCode: 2, message: "fetching the review result exceeded the time limit", findings: [], operationId };
    }
    text += chunk.chunk ?? "";
    expectedSha256 ??= chunk.sha256;
    const next = chunk.next_cursor ?? null;
    if (next !== null) {
      if (seenCursors.has(next)) {
        return {
          exitCode: 2,
          message: "the review result's cursor repeated; refusing to fetch forever",
          findings: [],
          operationId,
        };
      }
      seenCursors.add(next);
    }
    cursor = next;
    if (!cursor) break;
  }
  if (!expectedSha256) {
    return {
      exitCode: 2,
      message: "the review result had no checksum to verify it against",
      findings: [],
      operationId,
    };
  }
  const actual = sha256(text);
  if (actual !== expectedSha256) {
    return {
      exitCode: 2,
      message: "the review result's hash didn't match what Qodo reported",
      findings: [],
      operationId,
    };
  }

  let payload: LocalReviewPayload;
  try {
    payload = unwrapResult(text);
  } catch (error) {
    return {
      exitCode: 2,
      message: `the review result didn't parse: ${(error as Error).message}`,
      findings: [],
      operationId,
    };
  }
  deps.saveArtifact("review.json", `${JSON.stringify(payload, null, 2)}\n`);

  // A state list that doesn't hold findings with ids can't say which findings are open.
  if (!stateListsReadable(payload)) {
    return {
      exitCode: 3,
      message: "Qodo's finding_state lists don't hold findings with ids, so open and closed can't be told apart",
      findings: [],
      operationId,
    };
  }
  const findings = labelFindings(payload);
  const effort = payload.meta?.run?.effort?.effective ?? null;
  // Absent coverage counts as incomplete: a result that doesn't say what it covered proves no clean review.
  const coverageComplete = payload.meta?.coverage?.complete === true;
  const findingsComplete = payload.finding_state?.complete === true;
  const scopeComplete = deps.startParams.review_scope.complete;

  if (effort === "skip") {
    return { exitCode: 3, message: "Qodo skipped this review (review_effort: skip)", findings, operationId };
  }
  if (!coverageComplete) {
    return { exitCode: 3, message: "Qodo's coverage of this review was incomplete", findings, operationId };
  }
  if (!findingsComplete) {
    return {
      exitCode: 3,
      message: "Qodo did not report this review's finding inventory as complete",
      findings,
      operationId,
    };
  }
  if (!scopeComplete) {
    return {
      exitCode: 3,
      message: "the local snapshot sent for review was incomplete (some files were excluded)",
      findings,
      operationId,
    };
  }

  const openActionRequired = findings.filter((f) => f.open && f.severity === "action_required");
  if (openActionRequired.length) {
    return {
      exitCode: 1,
      message: `${openActionRequired.length} open action-required finding(s)`,
      findings,
      operationId,
    };
  }
  return { exitCode: 0, message: "completed, no open action-required finding", findings, operationId };
}

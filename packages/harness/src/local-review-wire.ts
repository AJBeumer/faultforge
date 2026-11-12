/**
 * The wire shapes and glue specific to Qodo's local-review tools: the request Qodo's
 * `start-pre-pr-review` wants, the managed-agent operation envelope every one of the three tools
 * answers with, saving every raw answer before it's parsed, and unwrapping the result chunk's own
 * extra layer of JSON into the review payload underneath.
 */
import type { SkippedFile } from "./local-diff.ts";
import type { LocalReviewPayload } from "./local-findings.ts";

export interface ReviewScope {
  stream_id: string;
  paths: string[];
  complete: boolean;
  excluded_files: string[];
  skipped_files: SkippedFile[];
}

export interface StartParams {
  repo_full_name: string;
  base_sha: string;
  diff: string;
  review_scope: ReviewScope;
  title?: string;
  description?: string;
}

export interface OperationError {
  code: string;
  message: string;
}

export interface OperationState {
  operation_id: string;
  status: "working" | "input_required" | "completed" | "failed" | "cancelled";
  terminal: boolean;
  result_available: boolean;
  poll_interval_seconds: number;
  error?: OperationError;
}

export interface ResultChunkPage {
  chunk?: string;
  next_cursor: string | null;
  sha256?: string;
}

/** The read tools this file calls through, scoped to just those three raw strings and bodies. */
export interface RawCapture {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  lastRaw: string;
  lastRecoveredRaw: string[];
}

/**
 * Calls one Qodo tool and saves every raw wire answer it produced — each body recovered from a
 * dropped session, then the final one — before the caller ever sees a parsed result. A tool-level
 * error (a non-JSON reply, or Qodo's own `isError`) still leaves its raw body on disk instead of
 * losing it to the throw: a real gap on `review:local`'s own first run on itself, 12 November.
 */
export async function callAndSaveRaw(
  api: RawCapture,
  tool: string,
  args: Record<string, unknown>,
  label: string,
  saveArtifact: (name: string, data: string) => void,
): Promise<unknown> {
  try {
    const result = await api.call(tool, args);
    api.lastRecoveredRaw.forEach((raw, i) => {
      saveArtifact(`${label}.recovered-${i}.raw.json`, raw);
    });
    saveArtifact(`${label}.raw.json`, api.lastRaw);
    return result;
  } catch (error) {
    api.lastRecoveredRaw.forEach((raw, i) => {
      saveArtifact(`${label}.recovered-${i}.raw.json`, raw);
    });
    if (api.lastRaw) saveArtifact(`${label}.error.raw.json`, api.lastRaw);
    throw error;
  }
}

/**
 * Qodo wraps a managed-agent result one level further than the chunk bytes themselves:
 * `{agent_id, output, terminal_state}`, where `output` is itself a JSON string whose `result` holds
 * the actual review payload (`findings`, `finding_state`, `meta`). Confirmed live, 12 November, on
 * this command's own first real run — an earlier version read the envelope as if it were the payload.
 */
export function unwrapResult(text: string): LocalReviewPayload {
  const envelope = JSON.parse(text) as { output?: unknown };
  if (typeof envelope.output !== "string") throw new Error('the review result has no "output" field to unwrap');
  const outer = JSON.parse(envelope.output) as { result?: LocalReviewPayload };
  if (!outer.result) throw new Error('the review result\'s "output" has no "result" field');
  return outer.result;
}

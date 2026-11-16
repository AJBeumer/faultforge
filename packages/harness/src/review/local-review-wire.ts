/**
 * The wire shapes of Qodo's local-review tools: the request, the operation each tool answers with, saving
 * every raw answer before it's parsed, and unwrapping the result into the review payload.
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

export interface RawCapture {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  lastRaw: string;
  lastRecoveredRaw: string[];
}

/**
 * Saves every raw answer a call produced, recovered sessions included, before the caller sees a parsed
 * result. A failed call still leaves its raw body on disk, so the throw loses no evidence.
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
 * Qodo wraps the result twice: `{agent_id, output, terminal_state}`, where `output` is a JSON string whose
 * `result` holds the review payload. Reading the envelope as the payload would find no findings.
 */
export function unwrapResult(text: string): LocalReviewPayload {
  const envelope = JSON.parse(text) as { output?: unknown };
  if (typeof envelope.output !== "string") throw new Error('the review result has no "output" field to unwrap');
  const outer = JSON.parse(envelope.output) as { result?: LocalReviewPayload };
  if (!outer.result) throw new Error('the review result\'s "output" has no "result" field');
  return outer.result;
}

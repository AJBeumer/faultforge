/**
 * Reads the saved local reviews under the evidence folder as records `review:gate` can compare: the trees each
 * one recorded, its base commit and repository, and whether it was complete (and if not, why). Split from
 * `review-gate.ts` (#254), which decides coverage and runs the command.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

export interface ReviewRecord {
  /** The saved file this came from, relative to the evidence folder where possible. */
  source: string;
  /** Every tree hash the review recorded (a checkpoint tree, a snapshot tree, or both). */
  trees: string[];
  baseSha: string | null;
  /** The repository the review was run for (`owner/name`), when the saved run says so. */
  repo: string | null;
  /** Qodo said its coverage of the change was complete. Absent counts as not complete. */
  complete: boolean;
  /** When not complete, which condition failed, in words; the gate's "not covered" reason (#254). */
  incompleteBecause?: string;
  /** Qodo skipped the review (`review_effort: skip`): it never really ran. */
  skipped: boolean;
  /** When the review was made, in ms: its own recorded time, else the saved file's time. */
  at: number;
}

export const HASH = /^[0-9a-f]{40}$/;
export const LINE_BREAK = String.fromCharCode(10);

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** What the run saved next to a review (`split.json`): which repository, and whether every changed
 * file reached Qodo. A review whose diff left a file out is never complete coverage, whatever Qodo's
 * own coverage flag says. */
export interface Sidecar {
  repo: string | null;
  scopeComplete: boolean;
}

/**
 * Which completeness condition a review fails, in words, or undefined when it meets them all. Coverage, the
 * finding inventory and the local snapshot must all be complete: the same three conditions under which
 * `review:local` itself will not exit 3. In the saved evidence the inventory flag is true exactly when Qodo
 * kept a checkpoint for the review, so the reason Qodo gives is passed on (#254).
 */
function whyIncomplete(
  meta: Record<string, unknown>,
  findingState: Record<string, unknown> | null,
  sidecar: Sidecar | null,
): string | undefined {
  if (asObject(meta.coverage)?.complete !== true) return "Qodo did not report its coverage as complete";
  if (findingState?.complete !== true) {
    const reason = asObject(meta.analysis)?.reason;
    if (reason === "checkpoint_unavailable")
      return "Qodo did not report its finding list as complete (checkpoint_unavailable: it kept no checkpoint)";
    return `Qodo did not report its finding list as complete${typeof reason === "string" ? ` (${reason})` : ""}`;
  }
  if (sidecar && !sidecar.scopeComplete) return "the local diff left a changed file out";
  return undefined;
}

/** Reads one parsed JSON document as a review record, or null when it is not a review with a tree.
 * Unwraps the managed-agent envelope (`{output: "<json>"}` holding `{result: payload}`) that earlier
 * saves used, and a bare `{result: payload}`. */
export function extractReviewRecord(
  doc: unknown,
  source: string,
  fileTimeMs: number,
  sidecar: Sidecar | null = null,
): ReviewRecord | null {
  let obj = asObject(doc);
  if (obj && typeof obj.output === "string") {
    try {
      obj = asObject(JSON.parse(obj.output));
    } catch {
      return null;
    }
  }
  if (obj && !obj.meta) obj = asObject(obj.result);
  const meta = asObject(obj?.meta);
  if (!meta) return null;

  const checkpoint = asObject(meta.checkpoint);
  const run = asObject(meta.run);
  const snapshot = asObject(run?.snapshot);
  const trees = [checkpoint?.tree_sha, snapshot?.tree_sha].filter(
    (t): t is string => typeof t === "string" && HASH.test(t),
  );
  if (trees.length === 0) return null;

  const effort = asObject(run?.effort);
  const baseSha = [checkpoint?.base_sha, snapshot?.base_sha].find((b): b is string => typeof b === "string") ?? null;
  const recorded = [checkpoint?.created_at, asObject(run?.timing)?.finished_at]
    .map((t) => (typeof t === "string" ? Date.parse(t) : Number.NaN))
    .find((t) => !Number.isNaN(t));
  const incompleteBecause = whyIncomplete(meta, asObject(obj?.finding_state), sidecar);
  return {
    source,
    trees: [...new Set(trees)],
    baseSha,
    complete: incompleteBecause === undefined,
    ...(incompleteBecause ? { incompleteBecause } : {}),
    repo: sidecar?.repo ?? null,
    skipped: effort?.effective === "skip",
    at: recorded ?? fileTimeMs,
  };
}

/** Raw transport answers, never a review result: not worth parsing. */
const NOT_A_RESULT = /^(poll|result|submit|cancel)(-\d+)?\.raw\.json$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function walk(dir: string, out: string[], problems: string[], top = true): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    problems.push(`cannot list ${dir}: ${(error as Error).message.split(LINE_BREAK)[0]}`);
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    // Top-level `reviews/` holds pull-request reviews, which are never read, so a failure to list it
    // must not be reported either.
    if (entry.isDirectory()) {
      if (!(top && entry.name === "reviews")) walk(path, out, problems, false);
    } else if (entry.name.endsWith(".json") && !NOT_A_RESULT.test(entry.name)) out.push(path);
  }
}

/** The `split.json` `review:local` saved beside a `review.json`, or null when there is none (older saves).
 * The scope counts as incomplete when the diff was never built, or left any file out. */
function readSidecar(reviewFile: string): Sidecar | null {
  if (basename(reviewFile) !== "review.json") return null;
  const unknownScope: Sidecar = { repo: null, scopeComplete: false };
  try {
    const split = asObject(JSON.parse(readFileSync(join(dirname(reviewFile), "split.json"), "utf8")));
    if (!split) return unknownScope;
    const left = (v: unknown) => (Array.isArray(v) ? v.length : 1);
    const scopeComplete =
      split.diffBuilt !== false && left(split.excludedFiles ?? []) === 0 && left(split.skippedFiles ?? []) === 0;
    return { repo: typeof split.repo === "string" ? split.repo : null, scopeComplete };
  } catch (error) {
    // No split.json at all is an older save. One that exists but cannot be read or parsed is not: it
    // may have recorded a file that never reached Qodo, so the review cannot count as complete.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : unknownScope;
  }
}

/** Every saved review with a recorded tree under `root`, however deep. A file that is not JSON, is too
 * large, or holds no review is skipped, never an error: the evidence folder also holds other things. */
export function readReviewRecords(root: string): { records: ReviewRecord[]; problems: string[] } {
  const files: string[] = [];
  const problems: string[] = [];
  walk(root, files, problems);
  const records: ReviewRecord[] = [];
  for (const file of files) {
    try {
      const relative = file.slice(root.length + 1);
      // `reviews/` holds review:wait's saves of pull-request reviews, made after the push: never
      // evidence that anything was reviewed before it was committed.
      if (relative.split(sep)[0] === "reviews") continue;
      const stat = statSync(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      const rec = extractReviewRecord(
        JSON.parse(readFileSync(file, "utf8")),
        file.slice(root.length + 1),
        stat.mtimeMs,
        readSidecar(file),
      );
      if (rec) records.push(rec);
    } catch (error) {
      // Not JSON is not a review. A file git cannot read might have been one: say so.
      if (!(error instanceof SyntaxError))
        problems.push(`cannot read ${file}: ${(error as Error).message.split(LINE_BREAK)[0]}`);
    }
  }
  return { records, problems };
}

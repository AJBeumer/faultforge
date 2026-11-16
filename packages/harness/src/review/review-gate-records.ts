/**
 * Reads the saved local reviews under the evidence folder as records `review:gate` can compare: the trees each
 * one recorded, its base commit and repository, and whether it was complete (and if not, why).
 * `review-gate.ts` decides coverage and runs the command.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { type ReviewCache, sidecarStamp, stampOf } from "./review-gate-cache.ts";

export interface ReviewRecord {
  /** Relative to the evidence folder where possible. */
  source: string;
  /** A checkpoint tree, a snapshot tree, or both. */
  trees: string[];
  baseSha: string | null;
  /** `owner/name`, when the saved run says so. */
  repo: string | null;
  /** Absent counts as not complete. */
  complete: boolean;
  /** Which condition failed, in words: the gate's "not covered" reason. */
  incompleteBecause?: string;
  /** Qodo skipped the review, so it never really ran. */
  skipped: boolean;
  /** In ms: the review's own recorded time, else the saved file's time. */
  at: number;
}

export const HASH = /^[0-9a-f]{40}$/;
export const LINE_BREAK = String.fromCharCode(10);

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The `split.json` beside a review. A diff that left a file out is never complete, whatever Qodo says. */
export interface Sidecar {
  repo: string | null;
  scopeComplete: boolean;
}

/**
 * Coverage, the finding list and the local diff must all be complete: the same conditions under which
 * `review:local` won't exit 3. The finding list is complete exactly when Qodo kept a checkpoint, so Qodo's
 * own reason is passed on.
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

/** Null when the document is not a review with a tree. Saves come in two wrappings, and both are unwrapped. */
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

/** Null for older saves, which have none. The scope is incomplete when the diff wasn't built or left a file out. */
function readSidecar(reviewFile: string): { sidecar: Sidecar | null; certain: boolean } {
  if (basename(reviewFile) !== "review.json") return { sidecar: null, certain: true };
  const unknownScope: Sidecar = { repo: null, scopeComplete: false };
  try {
    const split = asObject(JSON.parse(readFileSync(join(dirname(reviewFile), "split.json"), "utf8")));
    if (!split) return { sidecar: unknownScope, certain: true };
    const left = (v: unknown) => (Array.isArray(v) ? v.length : 1);
    const scopeComplete =
      split.diffBuilt !== false && left(split.excludedFiles ?? []) === 0 && left(split.skippedFiles ?? []) === 0;
    return { sidecar: { repo: typeof split.repo === "string" ? split.repo : null, scopeComplete }, certain: true };
  } catch (error) {
    // A split.json that exists but can't be read may have recorded a file that never reached Qodo, so the
    // review can't count as complete. Only a parse failure is cached: a failed read may succeed next time.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sidecar: null, certain: true };
    return { sidecar: unknownScope, certain: error instanceof SyntaxError };
  }
}

/**
 * A file that isn't a review is skipped, never an error: the evidence folder holds other things too. A file
 * that couldn't be read is never cached, so it is tried, and reported, every time.
 */
export function readReviewRecords(
  root: string,
  cache?: ReviewCache,
): { records: ReviewRecord[]; problems: string[]; parsed: number } {
  const files: string[] = [];
  const problems: string[] = [];
  walk(root, files, problems);
  const records: ReviewRecord[] = [];
  let parsed = 0;
  for (const file of files) {
    try {
      const relative = file.slice(root.length + 1);
      // `reviews/` holds review:wait's saves of pull-request reviews, made after the push: never
      // evidence that anything was reviewed before it was committed.
      if (relative.split(sep)[0] === "reviews") continue;
      const stat = statSync(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      // Stamped before reading, so a file that changes while it is read is read again next time.
      const sidecar = basename(file) === "review.json" ? sidecarStamp(join(dirname(file), "split.json")) : "none";
      const stamp = sidecar === null ? null : `${stampOf(stat)}|${sidecar}`;
      const known = cache?.get(relative, stamp);
      if (known) {
        if (known.record) records.push(known.record);
        continue;
      }
      parsed++;
      let rec: ReviewRecord | null;
      let certain = true;
      try {
        const doc = JSON.parse(readFileSync(file, "utf8"));
        const side = readSidecar(file);
        certain = side.certain;
        rec = extractReviewRecord(doc, relative, stat.mtimeMs, side.sidecar);
      } catch (error) {
        // Not JSON is not a review.
        if (!(error instanceof SyntaxError)) throw error;
        rec = null;
      }
      cache?.set(relative, certain ? stamp : null, rec);
      if (rec) records.push(rec);
    } catch (error) {
      // A file git cannot read might have been one: say so.
      problems.push(`cannot read ${file}: ${(error as Error).message.split(LINE_BREAK)[0]}`);
    }
  }
  return { records, problems, parsed };
}

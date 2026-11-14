/**
 * A review as `review:wait` saved it (`*.review.json`): where it lives, how it is written (once), found by
 * the commit it reviewed, and its findings in the shape the match rule reads. `review:wait` writes it;
 * `verdict`, `case:build` and `case:review` read it, all through this module, so the folder can't be
 * computed two ways (AUD-M24).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { MatchFinding } from "./match-rule.ts";
import { evidenceDir, evidenceKindDir, prEvidenceDir, privateDir } from "./paths.ts";

/**
 * The folder every saved review lives under: `<evidence>/reviews`, with the evidence folder taken from
 * `factory.json` and moved with private storage when `FAULTFORGE_PRIVATE_DIR` is set.
 */
export function savedReviewsDir(env: NodeJS.ProcessEnv = process.env): string {
  return evidenceKindDir(join(privateDir(env), basename(evidenceDir())), "reviews");
}

/** One PR's saves: `<savedReviewsDir>/<repoKey>-pr<N>`. */
export function savedReviewDir(repoKey: string, pr: number, env: NodeJS.ProcessEnv = process.env): string {
  return prEvidenceDir(join(privateDir(env), basename(evidenceDir())), "reviews", repoKey, pr);
}

/** The save of one commit in a PR's folder: `<first 7 of the SHA>.review.json`. */
export function savedReviewPath(dir: string, headSha: string): string {
  return join(dir, `${headSha.slice(0, 7)}.review.json`);
}

/** The state of the save at `path`, or undefined when there is none; "" when it can't be read as a save. */
function existingState(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const state = (JSON.parse(readFileSync(path, "utf8")) as { state?: unknown }).state;
    return typeof state === "string" ? state : "";
  } catch {
    return "";
  }
}

/**
 * Why a new save at `path` must be refused, or undefined: a complete save is final. An unfinished one
 * (timed out, skipped, head moved) may be followed by a later wait, which keeps it under another name.
 */
export function savedReviewRefusal(path: string): string | undefined {
  return existingState(path) === "complete"
    ? `${path} already holds a complete review: a saved review is evidence and is never overwritten`
    : undefined;
}

/**
 * Before a new wait for a commit whose save is unfinished: moves that save and every other file of the
 * commit (`<sha7>.*`: raw answers, comment feeds, head wait) into `<sha7>.unfinished-<n>/`, so the new wait
 * overwrites none of it. Returns the folder, or undefined when there was no save to keep.
 */
export function archiveUnfinished(dir: string, headSha: string): string | undefined {
  const path = savedReviewPath(dir, headSha);
  if (existingState(path) === undefined || existingState(path) === "complete") return undefined;
  const short = headSha.slice(0, 7);
  let n = 1;
  while (existsSync(join(dir, `${short}.unfinished-${n}`))) n++;
  const kept = join(dir, `${short}.unfinished-${n}`);
  mkdirSync(kept);
  for (const file of readdirSync(dir)) {
    const full = join(dir, file);
    if (file.startsWith(`${short}.`) && full !== kept && statSync(full).isFile()) renameSync(full, join(kept, file));
  }
  return kept;
}

/**
 * Writes a save, never over another (AUD-M26): a complete save makes this throw. An unfinished save is kept,
 * renamed `<sha7>.unfinished-<n>.json` (no longer a `.review.json`, so no lookup finds it), and the new save
 * is created exclusively, so two writers racing can't both succeed. A verdict that judged the unfinished save
 * names it in its hash, so `case:build` then refuses until the verdict is superseded.
 */
export function writeSavedReview(path: string, record: object): void {
  const refusal = savedReviewRefusal(path);
  if (refusal) throw new Error(refusal);
  if (existingState(path) !== undefined) {
    const stem = path.replace(/\.review\.json$/, "");
    let n = 1;
    while (existsSync(`${stem}.unfinished-${n}.json`)) n++;
    renameSync(path, `${stem}.unfinished-${n}.json`);
  }
  try {
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`a saved review appeared at ${path} while writing; it is evidence and is never overwritten`);
    }
    throw e;
  }
}

/** The relevant parts of a saved `*.review.json` (the shape `review:wait` writes). */
export interface SavedFinding {
  id: string;
  file: string | null;
  lines: [number, number] | null;
  title?: string | null;
  category?: string | null;
  description?: string | null;
}

export interface SavedReview {
  repo?: string;
  pr?: number;
  headSha: string;
  /**
   * "complete" only when `review:wait` saw the review of this commit finish. Anything else, including no
   * state at all, means the review did not finish, so a clean result proves nothing (AUD-M1).
   */
  state?: string;
  findings?: SavedFinding[];
}

/** The PR number an event names, however it was written: a number, a string, or `{ number }`. */
export function prNumberOf(value: unknown): number | undefined {
  const n = typeof value === "object" && value !== null ? (value as { number?: unknown }).number : value;
  const parsed = typeof n === "string" ? Number(n) : n;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * A case's PR, from its own events: the latest `pr.opened` (hand-written ones carry the number in three
 * shapes), else its `review.recorded`. Undefined when neither names one. The saved review is looked up by
 * it, so another PR's save of the same commit is never the one judged (AUD-M24).
 */
export function casePr(caseEvents: Record<string, unknown>[]): number | undefined {
  for (const type of ["pr.opened", "review.recorded"]) {
    const event = caseEvents.filter((e) => e.type === type).at(-1);
    const pr = event ? prNumberOf(event.pr) : undefined;
    if (pr !== undefined) return pr;
  }
  return undefined;
}

/** True only for a save whose review finished: an absent or unknown state is unfinished. */
export function isComplete(review: { state?: unknown }): boolean {
  return review.state === "complete";
}

/** A saved finding, in the shape the match rule and the report read. */
export function toMatchFinding(finding: SavedFinding): MatchFinding {
  return {
    id: finding.id,
    file: finding.file ?? null,
    lines: finding.lines ?? null,
    title: finding.title ?? null,
    summary: finding.description ?? null,
    category: finding.category ?? null,
  };
}

/**
 * The saved review whose `headSha` is `commit`, searched under `<reviewsDir>/<repoKey>-pr<N>/*.review.json`
 * (the layout `review:wait` writes). Undefined when the directory can't be read or no file matches. A
 * subfolder, or a `.review.json` file, that can't be listed, read or parsed is skipped, not thrown: one
 * case's malformed evidence must never abort the scan for a different case's valid review.
 */
export function findSavedReview(
  reviewsDir: string,
  commit: string,
  pr?: number,
): { path: string; text: string; review: SavedReview } | undefined {
  let dirs: string[];
  try {
    dirs = readdirSync(reviewsDir);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const full = join(reviewsDir, dir);
    let files: string[];
    try {
      if (!statSync(full).isDirectory()) continue;
      files = readdirSync(full);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".review.json")) continue;
      const path = join(full, file);
      try {
        const text = readFileSync(path, "utf8");
        const review = JSON.parse(text) as SavedReview;
        if (review.headSha === commit && (pr === undefined || review.pr === pr)) return { path, text, review };
      } catch {
        // Malformed or unreadable: not a candidate, but not fatal to the scan either.
      }
    }
  }
  return undefined;
}

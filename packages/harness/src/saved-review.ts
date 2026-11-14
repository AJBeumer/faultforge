/**
 * A review as `review:wait` saved it (`*.review.json`): where it lives, how it is written (once), found by
 * the commit it reviewed, and its findings in the shape the match rule reads. `review:wait` writes it;
 * `verdict`, `case:build` and `case:review` read it, all through this module, so the folder can't be
 * computed two ways (AUD-M24).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { MatchFinding } from "./match-rule.ts";
import { evidenceDir, privateDir } from "./paths.ts";

/**
 * The folder every saved review lives under: `<evidence>/reviews`, with the evidence folder taken from
 * `factory.json` and moved with private storage when `FAULTFORGE_PRIVATE_DIR` is set.
 */
export function savedReviewsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(privateDir(env), basename(evidenceDir()), "reviews");
}

/** One PR's saves: `<savedReviewsDir>/<repoKey>-pr<N>`. */
export function savedReviewDir(repoKey: string, pr: number, env: NodeJS.ProcessEnv = process.env): string {
  return join(savedReviewsDir(env), `${repoKey}-pr${pr}`);
}

/** The save of one commit in a PR's folder: `<first 7 of the SHA>.review.json`. */
export function savedReviewPath(dir: string, headSha: string): string {
  return join(dir, `${headSha.slice(0, 7)}.review.json`);
}

/**
 * Writes a save once. A save is the evidence a verdict judged (its hash is in the verdict), so it is never
 * replaced: an existing file makes this throw, and nothing is written (AUD-M26).
 */
export function writeSavedReview(path: string, record: object): void {
  try {
    writeFileSync(
      path,
      `${JSON.stringify(record, null, 2)}
`,
      { flag: "wx" },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`a saved review already exists at ${path}; it is evidence and is never overwritten`);
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

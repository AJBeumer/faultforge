/**
 * A review as `review:wait` saved it (`*.review.json`), found by the commit it reviewed, and its findings
 * in the shape the match rule reads. Used by `verdict`, `case:build` and `case:review`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MatchFinding } from "./match-rule.ts";

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
  /** "complete" when absent; anything else means the review did not finish, so a clean result proves nothing. */
  state?: string;
  findings?: SavedFinding[];
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

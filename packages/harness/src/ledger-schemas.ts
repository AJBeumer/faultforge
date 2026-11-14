/**
 * The JSON schemas for what private storage holds, applied to every line and file on disk (AUD-N5): each
 * answer-key line (`schemas/answer-key-entry.v1.json`: a planted bug, a control or an amendment) and each saved
 * review (`schemas/saved-review.v1.json`, what `review:wait` writes). `ledger:check` reports each one that
 * doesn't fit, by file and line, with the schema's own words; a shape the code doesn't expect is caught there,
 * not when a record is built from it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { parseJsonLines } from "./jsonl.ts";
import { ROOT } from "./paths.ts";

const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
const load = (name: string) => ajv.compile(JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")));
const answerKeyEntry = load("answer-key-entry.v1.json");
const savedReview = load("saved-review.v1.json");

/** The schema's complaints, short: where in the value, and what. */
function describe(errors: ErrorObject[] | null | undefined): string {
  const seen = new Set((errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`));
  return [...seen].slice(0, 5).join("; ");
}

/** Why `entry` doesn't fit the answer-key schema, or undefined. */
export function answerKeyEntryProblem(entry: unknown): string | undefined {
  return answerKeyEntry(entry) ? undefined : describe(answerKeyEntry.errors);
}

/** Why `review` doesn't fit the saved-review schema, or undefined. */
export function savedReviewProblem(review: unknown): string | undefined {
  return savedReview(review) ? undefined : describe(savedReview.errors);
}

/** A problem for each line of the answer key at `path` that isn't JSON or doesn't fit its schema. */
export function answerKeyProblems(path: string): string[] {
  if (!existsSync(path)) return [];
  let entries: unknown[];
  try {
    entries = parseJsonLines<unknown>(readFileSync(path, "utf8"));
  } catch (error) {
    // A line that isn't JSON: the reader names it, and nothing after it can be numbered reliably.
    return [`ground-truth.jsonl ${(error as Error).message}`];
  }
  // Numbered as entries: the answer key is written one entry per line, with no blank lines.
  return entries.flatMap((entry, i) => {
    const problem = answerKeyEntryProblem(entry);
    return problem ? [`ground-truth.jsonl line ${i + 1}: ${problem}`] : [];
  });
}

/** A problem for each saved review (`<reviewsDir>/<repo>-pr<N>/*.review.json`) that isn't JSON or doesn't fit. */
export function savedReviewProblems(reviewsDir: string): string[] {
  if (!existsSync(reviewsDir)) return [];
  const problems: string[] = [];
  for (const folder of readdirSync(reviewsDir).sort()) {
    const dir = join(reviewsDir, folder);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".review.json"))
      .sort()) {
      const label = `reviews/${folder}/${file}`;
      let review: unknown;
      try {
        review = JSON.parse(readFileSync(join(dir, file), "utf8"));
      } catch {
        problems.push(`${label}: not JSON`);
        continue;
      }
      const problem = savedReviewProblem(review);
      if (problem) problems.push(`${label}: ${problem}`);
    }
  }
  return problems;
}

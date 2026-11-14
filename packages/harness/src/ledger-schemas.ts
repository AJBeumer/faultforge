/**
 * The JSON schemas for what private storage holds, applied to every line and file on disk (AUD-N5): each
 * answer-key line (`schemas/answer-key-entry.v1.json`: a planted bug, a control or an amendment), each entry
 * again with its amendments applied, as the tools read it, and each saved review (`schemas/saved-review.v1.json`,
 * what `review:wait` writes), archived ones included. `ledger:check` reports each one that doesn't fit, by file
 * and line, with the schema's own words; a shape the code doesn't expect is caught there, not when a record is
 * built from it. A file that can't be read throws, for `ledger:check` to report as unreadable (exit 2).
 *
 * The schemas are compiled on first use, so a command that only imports this module through `ledger-check.ts`
 * never needs them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { parseJsonLines } from "./jsonl.ts";
import { readLedger } from "./ledger.ts";
import { ROOT } from "./paths.ts";

const compiled = new Map<string, ValidateFunction>();
function schema(name: string): ValidateFunction {
  let validate = compiled.get(name);
  if (!validate) {
    const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
    validate = ajv.compile(JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")));
    compiled.set(name, validate);
  }
  return validate;
}

/** The schema's complaints, short: where in the value, and what. */
function describe(errors: ErrorObject[] | null | undefined): string {
  const seen = new Set((errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`));
  return [...seen].slice(0, 5).join("; ");
}

function problemWith(name: string, value: unknown): string | undefined {
  const validate = schema(name);
  return validate(value) ? undefined : describe(validate.errors);
}

/** Why `entry` doesn't fit the answer-key schema, or undefined. */
export function answerKeyEntryProblem(entry: unknown): string | undefined {
  return problemWith("answer-key-entry.v1.json", entry);
}

/** Why `review` doesn't fit the saved-review schema, or undefined. */
export function savedReviewProblem(review: unknown): string | undefined {
  return problemWith("saved-review.v1.json", review);
}

/**
 * A problem for each line of the answer key at `path` that doesn't fit its schema, numbered by its line in the
 * file, and for each entry that no longer fits once its amendments are applied: an amendment may only change
 * an entry into another sound entry (Qodo on PR 289). A line that isn't JSON is one problem, named by the reader.
 */
export function answerKeyProblems(path: string): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  let entries: unknown[];
  try {
    entries = parseJsonLines<unknown>(text);
  } catch (error) {
    return [`ground-truth.jsonl ${(error as Error).message}`];
  }
  // The reader skips blank lines, so each entry's own line number is counted here (Qodo on PR 289).
  const lineOf = text.split("\n").flatMap((line, i) => (line.trim() ? [i + 1] : []));
  const problems = entries.flatMap((entry, i) => {
    const problem = answerKeyEntryProblem(entry);
    return problem ? [`ground-truth.jsonl line ${lineOf[i]}: ${problem}`] : [];
  });
  for (const { amendments, ...entry } of readLedger(path)) {
    if (!amendments.length) continue;
    const problem = answerKeyEntryProblem(entry);
    if (problem) problems.push(`ground-truth.jsonl ${String(entry.caseId)} as amended: ${problem}`);
  }
  return problems;
}

/** A saved review's file name: `<sha7>.review.json`, or an unfinished one kept as `<sha7>.unfinished-<n>.json`. */
const SAVE = /(^|\.)review\.json$|^[0-9a-f]{7}\.unfinished-\d+\.json$/;

/** Every saved review under `dir`, at any depth: archived saves sit in `<sha7>.unfinished-<n>/` folders. */
function savesUnder(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return savesUnder(path);
      return SAVE.test(name) ? [path] : [];
    });
}

/**
 * A problem for each saved review under `reviewsDir` (current and archived) that isn't JSON or doesn't fit.
 * A file that can't be read throws: that is a failure to check, never a problem with its content.
 */
export function savedReviewProblems(reviewsDir: string): string[] {
  if (!existsSync(reviewsDir)) return [];
  const problems: string[] = [];
  for (const path of savesUnder(reviewsDir)) {
    const label = `reviews/${relative(reviewsDir, path).split(sep).join("/")}`;
    const text = readFileSync(path, "utf8");
    let review: unknown;
    try {
      review = JSON.parse(text);
    } catch {
      problems.push(`${label}: not JSON`);
      continue;
    }
    const problem = savedReviewProblem(review);
    if (problem) problems.push(`${label}: ${problem}`);
  }
  return problems;
}

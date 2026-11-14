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
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { parseJsonLines } from "./jsonl.ts";
import { entryVersions, readLedger } from "./ledger.ts";
import { ROOT } from "./paths.ts";

let ajv: Ajv2020 | undefined;
const compiled = new Map<string, ValidateFunction>();
/** The validator for `ref` (a schema file's name, or a `#/$defs/...` inside one), compiled on first use. */
function schema(ref: string): ValidateFunction {
  let validate = compiled.get(ref);
  if (!validate) {
    if (!ajv) {
      ajv = new Ajv2020({ allErrors: true, validateFormats: false });
      for (const name of ["answer-key-entry.v1.json", "saved-review.v1.json"])
        ajv.addSchema(JSON.parse(readFileSync(join(ROOT, "schemas", name), "utf8")));
    }
    validate = ajv.compile({ $ref: ref });
    compiled.set(ref, validate);
  }
  return validate;
}

/** The schema's complaints, short: where in the value, what, and which field when one is unexpected. */
function describe(errors: ErrorObject[] | null | undefined): string {
  const said = (e: ErrorObject) => {
    const field = (e.params as { unevaluatedProperty?: string; additionalProperty?: string }) ?? {};
    const named = field.unevaluatedProperty ?? field.additionalProperty;
    return `${e.instancePath || "/"} ${e.message ?? "is invalid"}${named ? ` (${named})` : ""}`;
  };
  return [...new Set((errors ?? []).map(said))].slice(0, 5).join("; ");
}

function problemWith(ref: string, value: unknown): string | undefined {
  const validate = schema(ref);
  return validate(value) ? undefined : describe(validate.errors);
}

const KINDS = ["sabotage", "control", "amendment"];

/**
 * Why `entry` doesn't fit the answer-key schema, or undefined. Judged against its own kind's definition only,
 * so the complaints are about what it is, never about the kinds it was never meant to be (Qodo on PR 289).
 */
export function answerKeyEntryProblem(entry: unknown): string | undefined {
  const kind = (entry as { kind?: unknown } | null)?.kind;
  if (typeof kind !== "string" || !KINDS.includes(kind)) return `/kind must be one of ${KINDS.join(", ")}`;
  return problemWith(`answer-key-entry.v1.json#/$defs/${kind}`, entry);
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
  // Every version an amended entry has had, not only the last: a tool may have read any of them (Qodo on PR 289).
  for (const { amendments, caseId } of readLedger(path)) {
    if (!amendments.length || typeof caseId !== "string") continue;
    for (const [n, { amendments: _applied, ...version }] of entryVersions(path, caseId).entries()) {
      if (n === 0) continue; // the line itself, checked above
      const problem = answerKeyEntryProblem(version);
      if (problem) problems.push(`ground-truth.jsonl ${caseId} as amended (${n} of ${amendments.length}): ${problem}`);
    }
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
      // A link is never followed: one pointing back up would never end (Qodo on PR 289). review:wait makes none.
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return [];
      if (stat.isDirectory()) return savesUnder(path);
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

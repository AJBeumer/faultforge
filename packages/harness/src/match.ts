/**
 * Applies the fixed match rule to a published case record and prints the result.
 *
 *   npm run match -- examples/FF-0001.json
 *
 * The template's `match.kindTerms` come from the same place `npm run inject` reads the template: private
 * storage first (`FAULTFORGE_PRIVATE_DIR`, or `private/`), then `templates/seed`. Prints, for each finding,
 * the three criteria with their details, the finding's own line range and width, and the overall catch.
 *
 * Exit codes: 0 when the record's own `detection` agrees with the computed result, or the record has none
 * yet; 1 when they disagree, and the output says where; 2 when the record isn't a readable case record, or
 * its template can't be found, read or declares no usable terms.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMatchRule, isRange, type MatchFinding, type MatchRuleResult } from "./match-rule.ts";
import { kindTermsOf, templateDir } from "./templates.ts";

export interface CaseRecord {
  caseId?: string;
  injection?: { templateId: string; file: string; lines: [number, number] };
  findings: MatchFinding[];
  detection?: {
    caught: boolean;
    matchedFindingIds: string[];
    match: Record<"file" | "lines" | "kind", { pass: boolean }>;
  };
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  /** Where the report's lines go; stdout by default. */
  log?: (line: string) => void;
  /** Where a refusal goes; stderr by default. */
  error?: (line: string) => void;
}

function formatCriterion(name: string, criterion: { pass: boolean; detail: string }): string {
  return `  ${name}: ${criterion.pass ? "PASS" : "FAIL"} - ${criterion.detail}`;
}

/**
 * Everywhere the computed result and the record's own detection disagree. The record holds one set of
 * criteria: they describe the matched finding when there is one, or the only finding. A miss with several
 * findings leaves them unattributed, so only `caught` and the matched ids are compared then.
 */
export function disagreements(record: CaseRecord, result: MatchRuleResult): string[] {
  const detection = record.detection;
  if (!detection) return [];
  const problems: string[] = [];
  if (detection.caught !== result.caught) {
    problems.push(`caught: record says ${detection.caught}, computed says ${result.caught}`);
  }
  const recorded = [...detection.matchedFindingIds].sort();
  const computed = [...result.matchedFindingIds].sort();
  if (JSON.stringify(recorded) !== JSON.stringify(computed)) {
    problems.push(`matchedFindingIds: record says [${recorded.join(", ")}], computed says [${computed.join(", ")}]`);
  }
  const described = result.findings.length === 1 ? result.findings[0] : result.findings.find((f) => f.matched);
  if (described) {
    for (const criterion of ["file", "lines", "kind"] as const) {
      if (detection.match[criterion].pass !== described[criterion].pass) {
        problems.push(
          `match.${criterion}.pass: record says ${detection.match[criterion].pass}, computed says ${described[criterion].pass} for ${described.id}`,
        );
      }
    }
  }
  return problems;
}

/** True for a finding's field that is text, null or absent: anything else the rule can't read. */
const textual = (value: unknown) => value === undefined || value === null || typeof value === "string";

/** True for a finding's placement: null, or two numbers (the rule itself judges a reversed pair). */
const placement = (lines: unknown) =>
  lines === null || (Array.isArray(lines) && lines.length === 2 && lines.every((n) => typeof n === "number"));

/** Why the parsed file can't be matched, or undefined. The schema is checked elsewhere; this is the minimum. */
function shapeProblem(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return "is not a JSON object";
  const r = record as Partial<CaseRecord>;
  if (!Array.isArray(r.findings)) return "has no findings list";
  for (const f of r.findings as unknown[]) {
    const finding = f as Partial<MatchFinding> | null;
    if (!finding || typeof finding !== "object" || typeof finding.id !== "string") return "has a finding without an id";
    if (
      !(typeof finding.file === "string" || finding.file === null) ||
      !placement(finding.lines) ||
      ![finding.title, finding.summary, finding.category].every(textual)
    ) {
      return `has a finding (${finding.id}) whose file, lines, title, summary or category isn't what a finding holds`;
    }
  }
  if (!r.injection) return "has no injection to match against";
  const { templateId, file, lines } = r.injection;
  if (typeof templateId !== "string" || typeof file !== "string" || !isRange(lines)) {
    return "needs templateId, file and a line range in its injection";
  }
  return undefined;
}

export function run(recordPath: string, options: RunOptions = {}): number {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  let record: CaseRecord;
  try {
    record = JSON.parse(readFileSync(resolve(recordPath), "utf8"));
  } catch (e) {
    error(`match: can't read ${recordPath}: ${message(e)}`);
    return 2;
  }
  const shape = shapeProblem(record);
  if (shape || !record.injection) {
    error(`match: ${recordPath} ${shape}`);
    return 2;
  }
  const { injection } = record;
  const dir = templateDir(injection.templateId, env);
  if (!dir) {
    error(`match: template ${injection.templateId} not found in private/templates or templates/seed`);
    return 2;
  }
  let kindTerms: string[];
  try {
    kindTerms = kindTermsOf(JSON.parse(readFileSync(join(dir, "template.json"), "utf8")), `${dir}/template.json`);
  } catch (e) {
    error(`match: can't use ${dir}/template.json: ${message(e)}`);
    return 2;
  }

  const result = applyMatchRule(injection, record.findings, kindTerms);
  for (const finding of result.findings) {
    const source = record.findings.find((f) => f.id === finding.id);
    log(`${finding.id} ${source?.title ? `"${source.title}"` : ""}`.trim());
    log(formatCriterion("file", finding.file));
    log(formatCriterion("lines", finding.lines));
    log(formatCriterion("kind", finding.kind));
    const width =
      finding.lineWidth === null ? "no lines" : `${finding.lineWidth} line${finding.lineWidth === 1 ? "" : "s"}`;
    const range = source?.lines ? `lines ${source.lines[0]}-${source.lines[1]}` : "lines (none)";
    log(`  ${range}, ${width}`);
    if (source?.commentLines) {
      log(`  comment lines ${source.commentLines[0]}-${source.commentLines[1]} (information only)`);
    }
  }
  log(`caught: ${result.caught}`);
  log(`matched: ${result.matchedFindingIds.join(", ") || "none"}`);

  if (!record.detection) {
    log("(record has no detection to compare against)");
    return 0;
  }
  if (!result.caught && result.findings.length > 1) {
    log(
      "(a miss with several findings: the record's criteria name no one finding, so only caught and the matched ids are compared)",
    );
  }
  const problems = disagreements(record, result);
  if (problems.length) {
    for (const problem of problems) log(`disagrees: ${problem}`);
    return 1;
  }
  log("agrees with the record's own detection");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const recordPath = process.argv[2];
  if (!recordPath) {
    console.error("usage: npm run match -- <case record path>");
    process.exit(2);
  }
  process.exit(run(recordPath));
}

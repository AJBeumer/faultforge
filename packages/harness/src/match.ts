/**
 * Applies the fixed match rule to a published case record and prints the result.
 *
 *   npm run match -- examples/FF-0001.json
 *
 * Reads the template's `match.kindTerms` from `templates/seed/<templateId>/template.json`, then
 * `private/templates/<templateId>/template.json`. Prints, for each finding, the three criteria with
 * their details, the finding's own line range and width, and the overall catch.
 *
 * Exits 0 when the record's own `detection` agrees with the computed result, 1 when it disagrees
 * (the output says where), 2 when the record can't be read or its template can't be found.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMatchRule, type MatchFinding, type MatchRuleResult } from "./match-rule.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface Template {
  match?: { kindTerms?: string[] };
}

interface CaseRecord {
  caseId: string;
  injection?: { templateId: string; file: string; lines: [number, number] };
  findings: MatchFinding[];
  detection?: {
    caught: boolean;
    matchedFindingIds: string[];
    match: Record<"file" | "lines" | "kind", { pass: boolean }>;
  };
}

/** Where a template's match terms live: the seed copy first, then the private, unreleased one. */
function findTemplateDir(templateId: string): string | undefined {
  return [join(ROOT, "templates/seed", templateId), join(ROOT, "private/templates", templateId)].find((dir) =>
    existsSync(join(dir, "template.json")),
  );
}

function formatCriterion(name: string, criterion: { pass: boolean; detail: string }): string {
  return `  ${name}: ${criterion.pass ? "PASS" : "FAIL"} - ${criterion.detail}`;
}

/** Everywhere the computed result and the record's own detection disagree. */
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
  const reference = result.matchedFindingIds[0] ?? result.findings[0]?.id;
  const referenceResult = result.findings.find((f) => f.id === reference);
  if (referenceResult) {
    for (const criterion of ["file", "lines", "kind"] as const) {
      if (detection.match[criterion].pass !== referenceResult[criterion].pass) {
        problems.push(
          `match.${criterion}.pass: record says ${detection.match[criterion].pass}, computed says ${referenceResult[criterion].pass}`,
        );
      }
    }
  }
  return problems;
}

export function run(recordPath: string): number {
  let record: CaseRecord;
  try {
    record = JSON.parse(readFileSync(resolve(recordPath), "utf8"));
  } catch (error) {
    console.error(`match: can't read ${recordPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (!record.injection) {
    console.error(`match: ${record.caseId ?? recordPath} has no injection to match against`);
    return 2;
  }
  const templateDir = findTemplateDir(record.injection.templateId);
  if (!templateDir) {
    console.error(`match: template ${record.injection.templateId} not found in templates/seed or private/templates`);
    return 2;
  }
  const template: Template = JSON.parse(readFileSync(join(templateDir, "template.json"), "utf8"));
  const kindTerms = template.match?.kindTerms ?? [];
  if (!kindTerms.length) {
    console.error(`match: ${templateDir}/template.json is missing match.kindTerms`);
    return 2;
  }

  const result = applyMatchRule(record.injection, record.findings, kindTerms);

  for (const finding of result.findings) {
    const source = record.findings.find((f) => f.id === finding.id);
    console.log(`${finding.id} ${source?.title ? `"${source.title}"` : ""}`.trim());
    console.log(formatCriterion("file", finding.file));
    console.log(formatCriterion("lines", finding.lines));
    console.log(formatCriterion("kind", finding.kind));
    const width =
      finding.lineWidth === null ? "no lines" : `${finding.lineWidth} line${finding.lineWidth === 1 ? "" : "s"}`;
    const range = source?.lines ? `lines ${source.lines[0]}-${source.lines[1]}` : "lines (none)";
    console.log(`  ${range}, ${width}`);
    if (source?.commentLines) {
      console.log(`  comment lines ${source.commentLines[0]}-${source.commentLines[1]} (information only)`);
    }
  }
  console.log(`caught: ${result.caught}`);
  console.log(`matched: ${result.matchedFindingIds.join(", ") || "none"}`);

  const problems = disagreements(record, result);
  if (!record.detection) {
    console.log("(record has no detection to compare against)");
    return 0;
  }
  if (problems.length) {
    for (const problem of problems) console.log(`disagrees: ${problem}`);
    return 1;
  }
  console.log("agrees with the record's own detection");
  return 0;
}

// Exit codes: 0 agrees with the record's detection, 1 disagrees, 2 can't read the record or its template.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const recordPath = process.argv[2];
  if (!recordPath) {
    console.error("usage: npm run match -- <case record path>");
    process.exit(2);
  }
  process.exit(run(recordPath));
}

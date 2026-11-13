import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { isRange, normalisePath, overlaps } from "./match-rule.ts";

const root = join(import.meta.dirname, "../../..");
// Formats are documentation here; the checks that matter are structure and the fixed fields. Version 2 is
// version 1 plus two outcomes a control can have (#162); a record is checked against the version it names.
const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
const schemaChecks = {
  1: ajv.compile(JSON.parse(readFileSync(join(root, "schemas/case-record.v1.json"), "utf8"))),
  2: ajv.compile(JSON.parse(readFileSync(join(root, "schemas/case-record.v2.json"), "utf8"))),
};

/** The lowest record version that can hold a disposition: version 1 unless the outcome is new in version 2. */
export function recordVersionFor(kind: string, disposition: string): 1 | 2 {
  return kind === "control" && disposition !== "confirmed_clean" ? 2 : 1;
}

interface Detection {
  caught: boolean;
  matchedFindingIds: string[];
  match: Record<"file" | "lines" | "kind", { pass: boolean }>;
}

interface Finding {
  id: string;
  file: string | null;
  lines: [number, number] | null;
}

interface Injection {
  file: string;
  lines: [number, number];
  commit: string;
}

interface CaseRecord {
  findings: Finding[];
  detection?: Detection;
  human: { disposition: string };
  injection?: Injection;
  review?: { reviewedCommit: string };
}

/** Problems with a public case record, or an empty list if it is valid. */
export function validateCaseRecord(record: unknown): string[] {
  const version = (record as { schemaVersion?: unknown } | null)?.schemaVersion === 2 ? 2 : 1;
  const schemaCheck = schemaChecks[version];
  if (!schemaCheck(record)) {
    return (schemaCheck.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
  }
  return consistencyProblems(record as CaseRecord);
}

/** Cross-field rules JSON Schema can't express: a catch must follow from the findings and the match rule. */
function consistencyProblems({ findings, detection, human, injection, review }: CaseRecord): string[] {
  const problems: string[] = [];
  // One finding per id, or the checks below could judge a different finding from the one the rule matched.
  const seen = new Set<string>();
  for (const f of findings) {
    if (seen.has(f.id)) problems.push(`finding id ${f.id} appears more than once`);
    seen.add(f.id);
    if (f.lines !== null && !isRange(f.lines)) {
      problems.push(`finding ${f.id} has lines ${(f.lines as number[]).join("-")}, whose end comes before its start`);
    }
  }
  if (injection && !isRange(injection.lines)) {
    problems.push(`injection.lines ${(injection.lines as number[]).join("-")} ends before it starts`);
  }
  if (!detection) return problems;
  const findingsById = new Map(findings.map((f) => [f.id, f]));
  for (const id of detection.matchedFindingIds) {
    if (!findingsById.has(id)) problems.push(`detection names finding ${id}, which is not in findings`);
  }
  const allPass = Object.values(detection.match).every((c) => c.pass);
  if (detection.caught !== allPass) {
    problems.push(`caught is ${detection.caught}, but the match criteria ${allPass ? "all pass" : "do not all pass"}`);
  }
  if (detection.caught !== detection.matchedFindingIds.length > 0) {
    problems.push(`caught is ${detection.caught}, but ${detection.matchedFindingIds.length} findings are matched`);
  }
  const detected = human.disposition === "confirmed_detected";
  if (detected !== detection.caught && human.disposition !== "review_incomplete") {
    problems.push(`the owner's disposition ${human.disposition} disagrees with caught = ${detection.caught}`);
  }
  if (injection) {
    for (const id of detection.matchedFindingIds) {
      const finding = findingsById.get(id);
      if (!finding) continue;
      if (finding.file === null || finding.lines === null) {
        problems.push(`detection names finding ${id} as matched, but Qodo placed it nowhere`);
        continue;
      }
      if (normalisePath(finding.file) !== normalisePath(injection.file)) {
        problems.push(
          `detection names finding ${id} as matched, but its file ${finding.file} differs from the injected file ${injection.file}`,
        );
      }
      if (!overlaps(finding.lines, injection.lines)) {
        problems.push(
          `detection names finding ${id} as matched, but its lines ${finding.lines.join("-")} do not overlap the injected lines ${injection.lines.join("-")}`,
        );
      }
    }
    if (review && review.reviewedCommit !== injection.commit) {
      problems.push(`review.reviewedCommit ${review.reviewedCommit} differs from injection.commit ${injection.commit}`);
    }
  }
  return problems;
}

const PRIVATE_MARKERS = /private[/\\]|\.faultforge[/\\]|raw-artifacts|ground-truth|proofTest|proof\.test/i;

/** Private paths or fields that must never appear in a published record. */
export function findLeaks(text: string): string[] {
  return [...text.matchAll(new RegExp(PRIVATE_MARKERS, "gi"))].map((m) => m[0]);
}

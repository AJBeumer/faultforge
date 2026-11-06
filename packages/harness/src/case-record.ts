import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

const root = join(import.meta.dirname, "../../..");
const schema = JSON.parse(readFileSync(join(root, "schemas/case-record.v1.json"), "utf8"));

// Formats are documentation here; the checks that matter are structure and the fixed fields.
const schemaCheck = new Ajv2020({ allErrors: true, validateFormats: false }).compile(schema);

interface Detection {
  caught: boolean;
  matchedFindingIds: string[];
  match: Record<"file" | "lines" | "kind", { pass: boolean }>;
}

interface CaseRecord {
  findings: { id: string }[];
  detection?: Detection;
  human: { disposition: string };
}

/** Problems with a public case record, or an empty list if it is valid. */
export function validateCaseRecord(record: unknown): string[] {
  if (!schemaCheck(record)) {
    return (schemaCheck.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
  }
  return consistencyProblems(record as CaseRecord);
}

/** Cross-field rules JSON Schema can't express: a catch must follow from the findings and the match rule. */
function consistencyProblems({ findings, detection, human }: CaseRecord): string[] {
  if (!detection) return [];
  const problems: string[] = [];
  const ids = new Set(findings.map((f) => f.id));
  for (const id of detection.matchedFindingIds) {
    if (!ids.has(id)) problems.push(`detection names finding ${id}, which is not in findings`);
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
  return problems;
}

const PRIVATE_MARKERS = /private[/\\]|\.faultforge[/\\]|raw-artifacts|ground-truth|proofTest|proof\.test/i;

/** Private paths or fields that must never appear in a published record. */
export function findLeaks(text: string): string[] {
  return [...text.matchAll(new RegExp(PRIVATE_MARKERS, "gi"))].map((m) => m[0]);
}

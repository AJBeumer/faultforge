/**
 * The fixed match rule, transcribed as code: a finding counts as a catch only if it names the
 * injected file, overlaps the injected lines, and describes the right kind of problem. The wording
 * lives in `CLAUDE.md` and `docs/CHARTER.md`; this module only computes it.
 */

export interface Injection {
  file: string;
  lines: [number, number];
}

export interface MatchFinding {
  id: string;
  file: string | null;
  lines: [number, number] | null;
  /** Qodo's comment placement, printed for information only: the rule never matches against it. */
  commentLines?: [number, number] | null;
  title?: string | null;
  summary?: string | null;
  category?: string | null;
}

export interface Criterion {
  pass: boolean;
  detail: string;
}

export interface FindingMatch {
  id: string;
  file: Criterion;
  lines: Criterion;
  kind: Criterion;
  /** The width of the finding's own line range, in lines; null when Qodo placed it nowhere or the range is reversed. */
  lineWidth: number | null;
  matched: boolean;
}

/**
 * The version of the rule below. The rule is fixed: a change to what it computes is a new version, recorded
 * in the decision log, and never applied to a case adjudicated under an earlier one. Every result carries it,
 * so a stored result says which rule produced it (AUD-M11).
 */
export const RULE_VERSION = "1";

export interface MatchRuleResult {
  ruleVersion: string;
  findings: FindingMatch[];
  caught: boolean;
  matchedFindingIds: string[];
}

/** Separators normalised and a leading "./" stripped, so the same file reads the same either way. */
export function normalisePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function fileCriterion(injectionFile: string, findingFile: string | null): Criterion {
  if (findingFile === null) {
    return { pass: false, detail: "Qodo placed it nowhere: file is null" };
  }
  if (normalisePath(findingFile) === normalisePath(injectionFile)) {
    return { pass: true, detail: `the finding names ${injectionFile}, the changed file` };
  }
  return { pass: false, detail: `the finding names ${findingFile}, not the changed file ${injectionFile}` };
}

/** True for a line range as the schema means it: two whole numbers from 1, the end not before the start. */
export function isRange(lines: unknown): lines is [number, number] {
  return (
    Array.isArray(lines) &&
    lines.length === 2 &&
    lines.every((n) => Number.isInteger(n) && n >= 1) &&
    (lines[0] as number) <= (lines[1] as number)
  );
}

/**
 * Two ranges overlap when they share at least one line: [10,12] and [12,20] do, [10,12] and [13,20] don't.
 * A reversed range such as [20,10] describes no lines, so it overlaps nothing.
 */
export function overlaps(a: [number, number], b: [number, number]): boolean {
  return isRange(a) && isRange(b) && a[0] <= b[1] && b[0] <= a[1];
}

function linesCriterion(injectionLines: [number, number], findingLines: [number, number] | null): Criterion {
  if (findingLines === null) {
    return { pass: false, detail: "Qodo placed it nowhere: lines is null" };
  }
  const [fStart, fEnd] = findingLines;
  const [iStart, iEnd] = injectionLines;
  if (!isRange(findingLines)) {
    return { pass: false, detail: `finding lines ${fStart}-${fEnd} are not a range: the end comes before the start` };
  }
  if (!isRange(injectionLines)) {
    return { pass: false, detail: `the injected lines ${iStart}-${iEnd} are not a range: fix the record` };
  }
  if (overlaps(findingLines, injectionLines)) {
    return { pass: true, detail: `finding lines ${fStart}-${fEnd} overlap the changed lines ${iStart}-${iEnd}` };
  }
  return {
    pass: false,
    detail: `finding lines ${fStart}-${fEnd} do not overlap the changed lines ${iStart}-${iEnd}`,
  };
}

function kindCriterion(finding: MatchFinding, kindTerms: string[]): Criterion {
  const fields: { name: string; text: string | null | undefined }[] = [
    { name: "title", text: finding.title },
    { name: "summary", text: finding.summary },
    { name: "category", text: finding.category },
  ];
  for (const { name, text } of fields) {
    const lower = (text ?? "").toLowerCase();
    const term = kindTerms.find((t) => lower.includes(t.toLowerCase()));
    if (term) return { pass: true, detail: `"${term}" found in ${name}` };
  }
  return { pass: false, detail: "none of the defect's terms appear in the title, summary or category" };
}

function lineWidth(lines: [number, number] | null): number | null {
  return isRange(lines) ? lines[1] - lines[0] + 1 : null;
}

/** Pure: the answer depends only on the injection, the findings and the kind terms passed in. */
export function applyMatchRule(injection: Injection, findings: MatchFinding[], kindTerms: string[]): MatchRuleResult {
  const results = findings.map((finding) => {
    const file = fileCriterion(injection.file, finding.file);
    const lines = linesCriterion(injection.lines, finding.lines);
    const kind = kindCriterion(finding, kindTerms);
    return {
      id: finding.id,
      file,
      lines,
      kind,
      lineWidth: lineWidth(finding.lines),
      matched: file.pass && lines.pass && kind.pass,
    };
  });
  const matchedFindingIds = results.filter((r) => r.matched).map((r) => r.id);
  return { ruleVersion: RULE_VERSION, findings: results, caught: matchedFindingIds.length > 0, matchedFindingIds };
}

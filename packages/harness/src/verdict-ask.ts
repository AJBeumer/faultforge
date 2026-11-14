/**
 * How `verdict` shows a case to the owner and asks for answers: the match report and the terminal questions.
 * Split out of verdict.ts (module size rule) so the control-case path has room (#162).
 */
import { createInterface } from "node:readline/promises";
import type { MatchFinding, MatchRuleResult } from "./match-rule.ts";
import { normalReason } from "./verdict-event.ts";

export type AskFn = (question: string) => Promise<string>;

/** A finding's judgement, as the owner gives it. */
export type FindingVerdict = "real" | "false alarm" | "open";

const FINDING_VERDICTS = new Set(["real", "false alarm", "open"]);
const MAX_ATTEMPTS = 3;

function formatCriterion(name: string, criterion: { pass: boolean; detail: string }): string {
  return `  ${name}: ${criterion.pass ? "PASS" : "FAIL"} - ${criterion.detail}`;
}

/** Prints every finding's match against the rule, then the overall catch. */
export function printReport(log: (line: string) => void, findings: MatchFinding[], result: MatchRuleResult): void {
  for (const finding of result.findings) {
    const source = findings.find((f) => f.id === finding.id);
    log(`${finding.id} ${source?.title ? `"${source.title}"` : ""}`.trim());
    log(formatCriterion("file", finding.file));
    log(formatCriterion("lines", finding.lines));
    log(formatCriterion("kind", finding.kind));
    const width =
      finding.lineWidth === null ? "no lines" : `${finding.lineWidth} line${finding.lineWidth === 1 ? "" : "s"}`;
    const range = source?.lines ? `lines ${source.lines[0]}-${source.lines[1]}` : "lines (none)";
    log(`  ${range}, ${width}`);
    log(`  category: ${source?.category ?? "(none)"}`);
    log(`  summary: ${source?.summary ?? "(none)"}`);
  }
  log(`caught: ${result.caught}`);
  log(`matched: ${result.matchedFindingIds.join(", ") || "none"}`);
  log(`rule version: ${result.ruleVersion}`);
}

export async function defaultAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Asks until the answer (trimmed, lower-cased) is one of `valid`, or gives up after a few tries. */
export async function askOneOf(ask: AskFn, question: string, valid: string[]): Promise<string | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = (await ask(question)).trim().toLowerCase();
    if (valid.includes(answer)) return answer;
  }
  return undefined;
}

/** Asks until the answer (trimmed) is nonblank, or gives up after a few tries. */
export async function askNonBlank(ask: AskFn, question: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = (await ask(question)).trim();
    if (answer !== "") return answer;
  }
  return undefined;
}

/**
 * A reason that is this case's own: nonblank, and not one already given for another case (`taken`, as
 * `normalReason` gives them). Asked again a few times; then `{ taken }` says whether the last answer was
 * another case's reason rather than blank.
 */
export async function askOwnReason(
  ask: AskFn,
  question: string,
  taken: Set<string>,
): Promise<string | { taken: boolean }> {
  let wasTaken = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = (await ask(question)).trim();
    wasTaken = answer !== "" && taken.has(normalReason(answer));
    if (answer !== "" && !wasTaken) return answer;
  }
  return { taken: wasTaken };
}

/** A matched finding's judgement: real or a false alarm, explicitly. Blank or "open" leaves it unjudged. */
export async function askMatchedJudgement(
  ask: AskFn,
  question: string,
): Promise<{ verdict: FindingVerdict; explicit: true } | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = (await ask(question)).trim().toLowerCase();
    if (answer === "real" || answer === "false alarm") return { verdict: answer, explicit: true };
  }
  return undefined;
}

/**
 * A finding judgement: blank stays "open" at once, unjudged, and is never asked for a reason. Anything
 * else must be real, false alarm or open, and `explicit` tells the caller to require a reason for it.
 */
export async function askJudgement(
  ask: AskFn,
  question: string,
): Promise<{ verdict: FindingVerdict; explicit: boolean } | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = (await ask(question)).trim().toLowerCase();
    if (answer === "") return { verdict: "open", explicit: false };
    if (FINDING_VERDICTS.has(answer)) return { verdict: answer as FindingVerdict, explicit: true };
  }
  return undefined;
}

/** Prints a control's findings as Qodo placed them: there is no planted bug to match them against (#162). */
export function printControlFindings(log: (line: string) => void, findings: MatchFinding[]): void {
  for (const finding of findings) {
    log(`${finding.id} ${finding.title ? `"${finding.title}"` : ""}`.trim());
    const where = finding.lines ? `lines ${finding.lines[0]}-${finding.lines[1]}` : "lines (none)";
    log(`  ${finding.file ?? "(no file)"}, ${where}`);
    log(`  category: ${finding.category ?? "(none)"}`);
    log(`  summary: ${finding.summary ?? "(none)"}`);
  }
  log(`control: ${findings.length} finding${findings.length === 1 ? "" : "s"}, each for the owner to judge`);
}

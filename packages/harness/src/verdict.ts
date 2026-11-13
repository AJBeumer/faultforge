/**
 * Shows the owner the match between a planted bug and Qodo's saved review, asks for the verdict, and
 * records it.
 *
 *   npm run verdict -- FF-0001
 *   npm run verdict -- FF-0001 --dry-run           # prints the event it would append, writes nothing
 *   npm run verdict -- FF-0001 --review <path>     # read findings from this file instead of discovering one
 *
 * Reads the case's ground-truth entry (`readLedger`, #10) for the injected file, lines and template,
 * and the saved review (one of the `*.review.json` files `review:wait` writes) for the commit it
 * reviewed, found by matching `headSha` against the entry's `injectionCommit` (a `--review <path>` is
 * refused if its own `headSha` differs). Prints every finding's match against the fixed rule
 * (`applyMatchRule`, #18): file, lines, width, category and summary, then the overall catch. When the
 * saved review's own `state` is not `"complete"` (skipped, timed out, or the head moved on), a warning
 * is printed and the only verdict on offer is `review incomplete`: a clean result from an unfinished
 * review proves nothing.
 *
 * It then asks the owner, on the terminal: the verdict on the planted bug (`detected`, `missed` or
 * `review incomplete`, with a nonblank reason — retried, then refused, if left blank), and a judgement
 * on every other finding — every one Qodo raised that did not match the planted bug — as `real`,
 * `false alarm` or `open`, each with a nonblank reason. A blank answer instead leaves a finding `open`
 * at once, unjudged, with no reason asked; it is never recorded as a false alarm. Nothing is written
 * until every question is answered. The event — case id, commit reviewed, owner's login, UTC time, an
 * `inputHash` of the ground truth, the template and the review (so its exact inputs can be checked
 * later), the disposition, its reason and the judgements — is appended to `private/audit-events.jsonl`
 * as one `case.adjudicated` line, or printed instead of written with `--dry-run`.
 *
 * An answer the match rule contradicts (`detected` for a computed miss, `missed` for a computed catch) is
 * recorded only after the owner confirms it. It is then the owner's judgement on record, but `case:build`
 * will not publish it while its record's checks require the verdict to agree with the rule.
 *
 * Exit codes: 0 the event was appended (or, with `--dry-run`, printed); 1 stdin is not a terminal, so
 * there is nobody to ask — the match is printed, nothing is written; 2 nothing was written, because: the
 * answer key or audit log has an amendment problem (`ledgerProblems`); the case, its review or its template
 * can't be read; the review doesn't match the injected commit; an answer couldn't be parsed after retrying;
 * an answer the rule contradicts wasn't confirmed; or the event couldn't be appended.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { gh } from "./github.ts";
import { ledgerProblemsIn, readLedger } from "./ledger.ts";
import { applyMatchRule, type MatchFinding, type MatchRuleResult } from "./match-rule.ts";
import { kindTermsOf, privateDir, templateDir } from "./templates.ts";
import {
  type AskFn,
  askJudgement,
  askNonBlank,
  askOneOf,
  defaultAsk,
  printControlFindings,
  printReport,
} from "./verdict-ask.ts";

const ROOT = join(import.meta.dirname, "../../..");
const TOOL = `faultforge-harness@${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version}`;

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

export interface Judgement {
  id: string;
  verdict: "real" | "false alarm" | "open";
  reason: string;
}

export interface AdjudicationEvent {
  eventId: string;
  type: "case.adjudicated";
  at: string;
  caseId: string;
  commit: string;
  by: string;
  tool: string;
  environment: string;
  /** sha256 of the ground-truth entry, the template and the saved review, so the inputs can be checked later. */
  inputHash: string;
  disposition: string;
  reason: string;
  judgements: Judgement[];
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Whether there is a terminal to ask on; defaults to `process.stdin.isTTY`. */
  isTTY?: boolean;
  dryRun?: boolean;
  /** Read findings from this file instead of discovering one by the injected commit. */
  reviewPath?: string;
  groundTruthPath?: string;
  auditEventsPath?: string;
  reviewsDir?: string;
  ask?: AskFn;
  ownerLogin?: () => string;
  now?: () => string;
  append?: (path: string, value: object) => void;
}

const BUG_VERDICTS: Record<string, string> = {
  detected: "confirmed_detected",
  missed: "confirmed_missed",
  "review incomplete": "review_incomplete",
};

/**
 * A control has no planted bug to catch (#162): `clean` when Qodo raised nothing, `false alarm` when it
 * raised something on a harmless change, `review incomplete` when the review never finished.
 */
const CONTROL_VERDICTS: Record<string, string> = {
  clean: "confirmed_clean",
  "false alarm": "confirmed_false_alarm",
  "review incomplete": "review_incomplete",
};

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
        if (review.headSha === commit) return { path, text, review };
      } catch {
        // Malformed or unreadable: not a candidate, but not fatal to the scan either.
      }
    }
  }
  return undefined;
}

function defaultOwnerLogin(): string {
  return gh("api", "user", "--jq", ".login").trim();
}

function defaultAppend(path: string, value: object): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function run(caseId: string, options: RunOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const root = privateDir(env);
  const groundTruthPath = options.groundTruthPath ?? join(root, "ground-truth.jsonl");
  const auditEventsPath = options.auditEventsPath ?? join(root, "audit-events.jsonl");
  const reviewsDir = options.reviewsDir ?? join(root, "raw-artifacts", "reviews");

  // A verdict is appended only to an answer key and audit log whose amendments check out (#192). Checked
  // before anything is read from them: an amendment that changes a case id would hide the case itself.
  let ledgerIssues: string[];
  try {
    ledgerIssues = ledgerProblemsIn([groundTruthPath, auditEventsPath]);
  } catch (e) {
    error(`verdict: can't read ${groundTruthPath} or ${auditEventsPath}: ${message(e)}`);
    return 2;
  }
  if (ledgerIssues.length) {
    error(`verdict: the answer key or audit log has problems:\n${ledgerIssues.map((p) => `- ${p}`).join("\n")}`);
    return 2;
  }

  let entries: ReturnType<typeof readLedger>;
  try {
    entries = readLedger(groundTruthPath);
  } catch (e) {
    error(`verdict: can't read ${groundTruthPath}: ${message(e)}`);
    return 2;
  }
  const entry = entries.find((e) => e.caseId === caseId);
  if (!entry) {
    error(`verdict: no ground-truth entry for ${caseId} in ${groundTruthPath}`);
    return 2;
  }
  const injectedFile = entry.injectedFile;
  const injectedLines = entry.injectedLines;
  const templateId = entry.templateId;
  const injectionCommit = entry.injectionCommit;
  if (
    typeof injectedFile !== "string" ||
    !Array.isArray(injectedLines) ||
    typeof templateId !== "string" ||
    typeof injectionCommit !== "string"
  ) {
    error(
      `verdict: ${caseId}'s ground-truth entry is missing injectedFile, injectedLines, templateId or injectionCommit`,
    );
    return 2;
  }

  let reviewPath = options.reviewPath;
  let reviewText: string;
  let review: SavedReview;
  if (reviewPath) {
    try {
      reviewText = readFileSync(reviewPath, "utf8");
      review = JSON.parse(reviewText);
    } catch (e) {
      error(`verdict: can't read ${reviewPath}: ${message(e)}`);
      return 2;
    }
    if (review.headSha !== injectionCommit) {
      error(`verdict: ${reviewPath} reviewed ${review.headSha}, not ${caseId}'s injected commit ${injectionCommit}`);
      return 2;
    }
  } else {
    const found = findSavedReview(reviewsDir, injectionCommit);
    if (!found) {
      error(`verdict: no saved review.json for commit ${injectionCommit} under ${reviewsDir}; run review:wait first`);
      return 2;
    }
    reviewPath = found.path;
    reviewText = found.text;
    review = found.review;
  }

  const dir = templateDir(templateId, env);
  if (!dir) {
    error(`verdict: template ${templateId} not found in private/templates or templates/seed`);
    return 2;
  }
  // A control's template declares no match terms (the schema forbids them): there is no bug to match (#162).
  const isControl = entry.kind === "control";
  let templateText: string;
  let kindTerms: string[] = [];
  try {
    templateText = readFileSync(join(dir, "template.json"), "utf8");
    if (!isControl) kindTerms = kindTermsOf(JSON.parse(templateText), `${dir}/template.json`);
  } catch (e) {
    error(`verdict: can't use ${dir}/template.json: ${message(e)}`);
    return 2;
  }

  const findings = (review.findings ?? []).map(toMatchFinding);
  const result = isControl
    ? undefined
    : applyMatchRule({ file: injectedFile, lines: injectedLines as [number, number] }, findings, kindTerms);
  if (result) printReport(log, findings, result);
  else printControlFindings(log, findings);

  // "complete" only when review:wait finished reviewing this exact commit; anything else (skipped,
  // timed out, head moved) means a clean result proves nothing, so only "review incomplete" is offered.
  const reviewIncomplete = typeof review.state === "string" && review.state !== "complete";
  if (reviewIncomplete) {
    log(
      `WARNING: the saved review's state is "${review.state}", not complete. A missing finding may mean the review never finished, not that nothing was found; only "review incomplete" can be recorded.`,
    );
  }

  const isTTY = options.isTTY ?? process.stdin.isTTY === true;
  if (!isTTY) {
    log("(no terminal to ask on: nothing written)");
    return 1;
  }

  let by: string;
  try {
    by = (options.ownerLogin ?? defaultOwnerLogin)();
  } catch (e) {
    error(`verdict: can't determine the owner's login: ${message(e)}`);
    return 2;
  }

  const ask = options.ask ?? defaultAsk;
  // A control offers `clean` only when Qodo raised nothing, and `false alarm` only when it raised something.
  const verdicts = isControl ? CONTROL_VERDICTS : BUG_VERDICTS;
  const offered = isControl
    ? [findings.length ? "false alarm" : "clean", "review incomplete"]
    : ["detected", "missed", "review incomplete"];
  const allowedBugWords = reviewIncomplete ? ["review incomplete"] : offered;
  const subject = isControl ? "the control" : "the planted bug";
  const bugAnswer = await askOneOf(ask, `Verdict on ${subject} (${offered.join("/")}): `, allowedBugWords);
  if (!bugAnswer) {
    error(
      `verdict: no valid answer (${offered.slice(0, -1).join(", ")} or ${offered.at(-1)}) for ${subject}'s verdict`,
    );
    return 2;
  }
  // An answer the rule contradicts is a permanent line in an append-only log: asked again first (#192).
  if (result && bugAnswer !== "review incomplete" && (bugAnswer === "detected") !== result.caught) {
    const sure = await askOneOf(
      ask,
      `The rule says caught = ${result.caught}, but the answer is "${bugAnswer}". Record it anyway? (yes/no): `,
      ["yes", "no"],
    );
    if (sure !== "yes") {
      error(`verdict: "${bugAnswer}" contradicts the rule (caught = ${result.caught}) and was not confirmed`);
      return 2;
    }
  }
  const bugReason = await askNonBlank(ask, "Reason: ");
  if (bugReason === undefined) {
    error(`verdict: no reason given for ${subject}'s verdict`);
    return 2;
  }

  const judgements: Judgement[] = [];
  // On a control every finding is judged: none can be a catch.
  for (const finding of result?.findings ?? findings) {
    if (result?.matchedFindingIds.includes(finding.id)) continue;
    const source = findings.find((f) => f.id === finding.id);
    const judged = await askJudgement(
      ask,
      `Judge ${finding.id}${source?.title ? ` "${source.title}"` : ""} (real/false alarm/open, blank = open): `,
    );
    if (judged === undefined) {
      error(`verdict: no valid answer (real, false alarm or open) for finding ${finding.id}`);
      return 2;
    }
    let reason = "";
    if (judged.explicit) {
      const given = await askNonBlank(ask, "Reason: ");
      if (given === undefined) {
        error(`verdict: no reason given for finding ${finding.id}'s judgement`);
        return 2;
      }
      reason = given;
    }
    judgements.push({ id: finding.id, verdict: judged.verdict, reason });
  }

  // A control with a finding the owner judges real wasn't clean, so it is neither clean nor a false alarm
  // (owner's decision, 13 November): the template or the case needs a look before any verdict is recorded.
  if (isControl && bugAnswer !== "review incomplete" && judgements.some((j) => j.verdict === "real")) {
    error(
      "verdict: a finding on this control is judged real, so the control was not clean; nothing recorded. Check the template, or record review incomplete with the reason",
    );
    return 2;
  }

  const event: AdjudicationEvent = {
    eventId: randomUUID(),
    type: "case.adjudicated",
    at: (options.now ?? (() => new Date().toISOString()))(),
    caseId,
    commit: review.headSha,
    by,
    tool: TOOL,
    environment: `${platform()}-${arch()}-node${process.versions.node}`,
    inputHash: sha256(`${JSON.stringify(entry)}\n${templateText}\n${reviewText}`),
    disposition: verdicts[bugAnswer] as string,
    reason: bugReason,
    judgements,
  };

  if (options.dryRun) {
    log(`(dry run) would append to ${auditEventsPath}:`);
    log(JSON.stringify(event, null, 2));
    return 0;
  }
  try {
    (options.append ?? defaultAppend)(auditEventsPath, event);
  } catch (e) {
    error(`verdict: can't append to ${auditEventsPath}: ${message(e)}`);
    return 2;
  }
  log(`recorded: ${caseId} ${event.disposition}, ${judgements.length} other finding(s) judged`);
  return 0;
}

interface CliArgs {
  caseId: string;
  dryRun: boolean;
  reviewPath?: string;
}

/** The command line, or null when it's wrong. */
export function parseCliArgs(argv: string[]): CliArgs | null {
  let values: { "dry-run"?: boolean; review?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseNodeArgs({
      args: argv,
      options: { "dry-run": { type: "boolean" }, review: { type: "string" } },
      allowPositionals: true,
    }));
  } catch {
    return null;
  }
  const [caseId] = positionals;
  if (!caseId) return null;
  return { caseId, dryRun: values["dry-run"] ?? false, reviewPath: values.review };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed) {
    console.error("usage: npm run verdict -- <caseId> [--dry-run] [--review <path>]");
    process.exit(2);
  }
  run(parsed.caseId, { dryRun: parsed.dryRun, reviewPath: parsed.reviewPath }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`verdict: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}

// Kept importable from here, where callers found them before the split.
export { type AskFn, printReport } from "./verdict-ask.ts";

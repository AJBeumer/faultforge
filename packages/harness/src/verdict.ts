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
 * Exit codes: 0 the event was appended (or, with `--dry-run`, printed); 1 stdin is not a terminal, so
 * there is nobody to ask — the match is printed, nothing is written; 2 the case, its review or its
 * template can't be read, the review doesn't match the injected commit, the event couldn't be appended,
 * or an answer couldn't be parsed after retrying.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { gh } from "./github.ts";
import { ledgerProblemsIn, readLedger } from "./ledger.ts";
import { applyMatchRule, type MatchFinding, type MatchRuleResult } from "./match-rule.ts";
import { kindTermsOf, privateDir, templateDir } from "./templates.ts";

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

export type AskFn = (question: string) => Promise<string>;

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

const FINDING_VERDICTS = new Set(["real", "false alarm", "open"]);
const MAX_ATTEMPTS = 3;

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
}

async function defaultAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
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

/** Asks until the answer (trimmed, lower-cased) is one of `valid`, or gives up after a few tries. */
async function askOneOf(ask: AskFn, question: string, valid: string[]): Promise<string | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = (await ask(question)).trim().toLowerCase();
    if (valid.includes(answer)) return answer;
  }
  return undefined;
}

/** Asks until the answer (trimmed) is nonblank, or gives up after a few tries. */
async function askNonBlank(ask: AskFn, question: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = (await ask(question)).trim();
    if (answer !== "") return answer;
  }
  return undefined;
}

/**
 * A finding judgement: blank stays "open" at once, unjudged, and is never asked for a reason. Anything
 * else must be real, false alarm or open, and `explicit` tells the caller to require a reason for it.
 */
async function askJudgement(
  ask: AskFn,
  question: string,
): Promise<{ verdict: Judgement["verdict"]; explicit: boolean } | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = (await ask(question)).trim().toLowerCase();
    if (answer === "") return { verdict: "open", explicit: false };
    if (FINDING_VERDICTS.has(answer)) return { verdict: answer as Judgement["verdict"], explicit: true };
  }
  return undefined;
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
  let templateText: string;
  let kindTerms: string[];
  try {
    templateText = readFileSync(join(dir, "template.json"), "utf8");
    kindTerms = kindTermsOf(JSON.parse(templateText), `${dir}/template.json`);
  } catch (e) {
    error(`verdict: can't use ${dir}/template.json: ${message(e)}`);
    return 2;
  }

  const findings = (review.findings ?? []).map(toMatchFinding);
  const result = applyMatchRule({ file: injectedFile, lines: injectedLines as [number, number] }, findings, kindTerms);
  printReport(log, findings, result);

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
  const allowedBugWords = reviewIncomplete ? ["review incomplete"] : Object.keys(BUG_VERDICTS);
  const bugAnswer = await askOneOf(
    ask,
    "Verdict on the planted bug (detected/missed/review incomplete): ",
    allowedBugWords,
  );
  if (!bugAnswer) {
    error("verdict: no valid answer (detected, missed or review incomplete) for the planted bug's verdict");
    return 2;
  }
  // An answer the rule contradicts is a permanent line in an append-only log: asked again first (#192).
  if (bugAnswer !== "review incomplete" && (bugAnswer === "detected") !== result.caught) {
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
    error("verdict: no reason given for the planted bug's verdict");
    return 2;
  }

  const judgements: Judgement[] = [];
  for (const finding of result.findings) {
    if (result.matchedFindingIds.includes(finding.id)) continue;
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
    disposition: BUG_VERDICTS[bugAnswer] as string,
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

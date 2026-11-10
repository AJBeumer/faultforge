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
 * reviewed, found by matching `headSha` against the entry's `injectionCommit`. Prints every finding's
 * match against the fixed rule (`applyMatchRule`, #18): file, lines, width, category and summary, then
 * the overall catch.
 *
 * It then asks the owner, on the terminal: the verdict on the planted bug (`detected`, `missed` or
 * `review incomplete`, with a reason), and a judgement on every other finding — every one Qodo raised
 * that did not match the planted bug — as `real`, `false alarm` or `open`, with a reason. A blank
 * answer leaves a finding `open`; it is never recorded as a false alarm. Nothing is written until every
 * question is answered. The event — case id, commit reviewed, owner's login, UTC time, disposition,
 * its reason and the judgements — is appended to `private/audit-events.jsonl` as one `case.adjudicated`
 * line, or printed instead of written with `--dry-run`.
 *
 * Exit codes: 0 the event was appended (or, with `--dry-run`, printed); 1 stdin is not a terminal, so
 * there is nobody to ask — the match is printed, nothing is written; 2 the case, its review or its
 * template can't be read, or the owner's answer couldn't be parsed after retrying.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { readLedger } from "./ledger.ts";
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
 * (the layout `review:wait` writes). Undefined when the directory can't be read or no file matches.
 */
export function findSavedReview(reviewsDir: string, commit: string): { path: string; review: SavedReview } | undefined {
  let dirs: string[];
  try {
    dirs = readdirSync(reviewsDir);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const full = join(reviewsDir, dir);
    if (!statSync(full).isDirectory()) continue;
    for (const file of readdirSync(full)) {
      if (!file.endsWith(".review.json")) continue;
      const path = join(full, file);
      const review = JSON.parse(readFileSync(path, "utf8")) as SavedReview;
      if (review.headSha === commit) return { path, review };
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
  return execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", timeout: 15_000 }).trim();
}

function defaultAppend(path: string, value: object): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

/** Asks until the answer (trimmed, lower-cased) is one of `valid`, or gives up after a few tries. */
async function askOneOf(ask: AskFn, question: string, valid: string[]): Promise<string | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = (await ask(question)).trim().toLowerCase();
    if (valid.includes(answer)) return answer;
  }
  return undefined;
}

/** A finding judgement: blank stays "open" at once; anything else must be real, false alarm or open. */
async function askJudgement(ask: AskFn, question: string): Promise<Judgement["verdict"] | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = (await ask(question)).trim().toLowerCase();
    if (answer === "") return "open";
    if (FINDING_VERDICTS.has(answer)) return answer as Judgement["verdict"];
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
  let review: SavedReview;
  if (reviewPath) {
    try {
      review = JSON.parse(readFileSync(reviewPath, "utf8"));
    } catch (e) {
      error(`verdict: can't read ${reviewPath}: ${message(e)}`);
      return 2;
    }
  } else {
    const found = findSavedReview(reviewsDir, injectionCommit);
    if (!found) {
      error(`verdict: no saved review.json for commit ${injectionCommit} under ${reviewsDir}; run review:wait first`);
      return 2;
    }
    reviewPath = found.path;
    review = found.review;
  }

  const dir = templateDir(templateId, env);
  if (!dir) {
    error(`verdict: template ${templateId} not found in private/templates or templates/seed`);
    return 2;
  }
  let kindTerms: string[];
  try {
    kindTerms = kindTermsOf(JSON.parse(readFileSync(join(dir, "template.json"), "utf8")), `${dir}/template.json`);
  } catch (e) {
    error(`verdict: can't use ${dir}/template.json: ${message(e)}`);
    return 2;
  }

  const findings = (review.findings ?? []).map(toMatchFinding);
  const result = applyMatchRule({ file: injectedFile, lines: injectedLines as [number, number] }, findings, kindTerms);
  printReport(log, findings, result);

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
  const bugAnswer = await askOneOf(
    ask,
    "Verdict on the planted bug (detected/missed/review incomplete): ",
    Object.keys(BUG_VERDICTS),
  );
  if (!bugAnswer) {
    error("verdict: no valid answer (detected, missed or review incomplete) for the planted bug's verdict");
    return 2;
  }
  const bugReason = (await ask("Reason: ")).trim();

  const judgements: Judgement[] = [];
  for (const finding of result.findings) {
    if (result.matchedFindingIds.includes(finding.id)) continue;
    const source = findings.find((f) => f.id === finding.id);
    const verdict = await askJudgement(
      ask,
      `Judge ${finding.id}${source?.title ? ` "${source.title}"` : ""} (real/false alarm/open, blank = open): `,
    );
    if (verdict === undefined) {
      error(`verdict: no valid answer (real, false alarm or open) for finding ${finding.id}`);
      return 2;
    }
    const reason = (await ask("Reason: ")).trim();
    judgements.push({ id: finding.id, verdict, reason });
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
    disposition: BUG_VERDICTS[bugAnswer] as string,
    reason: bugReason,
    judgements,
  };

  if (options.dryRun) {
    log(`(dry run) would append to ${auditEventsPath}:`);
    log(JSON.stringify(event, null, 2));
    return 0;
  }
  (options.append ?? defaultAppend)(auditEventsPath, event);
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
  const [caseId, ...rest] = argv;
  if (!caseId) return null;
  const dryRun = rest.includes("--dry-run");
  const at = rest.indexOf("--review");
  const reviewPath = at >= 0 ? rest[at + 1] : undefined;
  if (at >= 0 && !reviewPath) return null;
  return { caseId, dryRun, reviewPath };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed) {
    console.error("usage: npm run verdict -- <caseId> [--dry-run] [--review <path>]");
    process.exit(2);
  }
  run(parsed.caseId, { dryRun: parsed.dryRun, reviewPath: parsed.reviewPath }).then((code) => process.exit(code));
}

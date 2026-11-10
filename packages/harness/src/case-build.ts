/**
 * Builds the public case record from saved evidence, instead of it being edited by hand. A generated
 * record can't drift from the events that back it, and anyone can regenerate it from the same inputs.
 *
 *   npm run case:build -- FF-0001              # prints the record
 *   npm run case:build -- FF-0001 --write      # writes examples/<caseId>.json
 *
 * Reads, for `<caseId>`:
 *  - the ground-truth entry (`readLedger`, amendments applied): `injection` and `target`.
 *  - the case's audit events (`readAuditLog`, amendments applied), filtered to this case. Three stages
 *    are required, and a case missing one is refused, naming it: `sabotage.injected` or
 *    `control.injected` (the case was planted); `review.recorded` (`pr` and the parts of `review` no
 *    saved review carries: `reviewer`, `path`, `configVersion`, `reviewedCommit`, `reviewedAt`, `url`);
 *    `case.adjudicated` (`human.disposition`, `.adjudicatedBy` from `by`, `.adjudicatedAt` from `at`).
 *  - the saved review (`review:wait`'s `<evidence>/reviews/<key>-pr<N>/*.review.json`, matched by
 *    `reviewedCommit`, via `findSavedReview` from `verdict.ts`) for `findings`. A review that predates
 *    `review:wait` (so far, only FF-0001) has none; the overlay then names a raw findings file instead
 *    (`legacyFindingsPath`), read in Qodo's API shape and converted with `findingsFor` (`review-wait.ts`).
 *  - `private/cases/<caseId>.overlay.json`: prose no event or saved review holds —
 *    `detection.notes`, `collateral`, `otherReviewers`, `challenge`, `review.linkedRepositories` — and,
 *    only for a review that predates `review:wait` and the current wording of `match-rule.ts`'s
 *    criteria, two narrow extras: `detection.matchDetailOverrides` (replaces a criterion's free-text
 *    `detail`, never its `pass`) and `findings` (per-id `severity`/`commentLines`, which a legacy raw
 *    findings file doesn't carry). The command refuses any other field, naming it, and prints which
 *    fields it took from the overlay.
 *
 * `detection` comes from `applyMatchRule`: the matched finding's criteria when caught, the first
 * finding's otherwise, folded into the schema's single `match` object (one set of criteria, not one
 * per finding) and (for a legacy review only) re-worded by `matchDetailOverrides`.
 *
 * Exit codes: 0 the record is valid and leak-free (`validateCaseRecord` + `findLeaks`), printed or
 * written; 1 the record fails those checks, or the overlay sets a field it isn't allowed to (problems
 * listed); 2 an input (ledger, events, template, saved review or overlay) is missing, unreadable, or
 * the case is missing a required stage (named in the message).
 */

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findLeaks, validateCaseRecord } from "./case-record.ts";
import { type LedgerEntry, readAuditLog, readLedger } from "./ledger.ts";
import { applyMatchRule, type Criterion, isRange, type MatchFinding } from "./match-rule.ts";
import { type Finding, findingsFor, type QodoReview } from "./review-wait.ts";
import { kindTermsOf, privateDir, templateDir } from "./templates.ts";
import { findSavedReview, toMatchFinding } from "./verdict.ts";

const ROOT = join(import.meta.dirname, "../../..");
const SCHEMA_REF = "../schemas/case-record.v1.json";
/** Qodo is the only reviewer a case record counts, and every saved review was read via its PR comments. */
const REVIEWER = "qodo-code-review[bot]";
const REVIEW_PATH = "pr-comments";
/** This repo, where adjudicated templates are published, for `injection.template`. */
const TEMPLATE_REPO = "AJBeumer/faultforge";

export interface Overlay {
  detection?: {
    notes?: string[];
    /** Replaces a criterion's `detail` text for a review that predates match-rule.ts's current wording. */
    matchDetailOverrides?: Partial<Record<"file" | "lines" | "kind", string>>;
  };
  collateral?: unknown[];
  otherReviewers?: unknown[];
  challenge?: { verdict: string; note: string };
  review?: { linkedRepositories?: string };
  /** Per-id overrides a legacy findings file can't carry: `severity`, `commentLines`, and a human-edited `summary`. */
  findings?: { id: string; severity?: string; commentLines?: [number, number]; summary?: string }[];
  /** Where to read findings when no saved review exists, relative to the repo root. */
  legacyFindingsPath?: string;
}

export interface BuildInputs {
  entry: LedgerEntry;
  events: LedgerEntry[];
  findings: Finding[];
  overlay: Overlay;
  kindTerms: string[];
  /** `injection.template`'s URL, when the template has been published to `templates/seed`. */
  templateUrl?: string;
}

/** Strips a git remote URL down to `owner/repo`. */
export function repoSlug(url: string): string {
  return url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
}

function requireEvent(events: LedgerEntry[], types: string[], stage: string): LedgerEntry {
  const found = events.find((e) => types.includes(e.type as string));
  if (!found) throw new Error(`${stage} is missing: no ${types.join(" or ")} event for this case`);
  return found;
}

function requireField<T>(event: LedgerEntry, field: string, stage: string): T {
  const value = (event as Record<string, unknown>)[field];
  if (value === undefined || value === null) throw new Error(`${stage} is missing its ${field} field`);
  return value as T;
}

/** One criterion set folded from per-finding results: the matched finding's when caught, else the first's. */
function foldedMatch(
  findings: ReturnType<typeof applyMatchRule>["findings"],
  matchedFindingIds: string[],
): Record<"file" | "lines" | "kind", Criterion> {
  const picked = findings.find((f) => matchedFindingIds.includes(f.id)) ?? findings[0];
  if (!picked) {
    const none: Criterion = { pass: false, detail: "no findings to match against" };
    return { file: none, lines: none, kind: none };
  }
  return { file: picked.file, lines: picked.lines, kind: picked.kind };
}

/** Pure: the public record depends only on the entry, this case's events, its findings and its overlay. */
export function buildCaseRecord(inputs: BuildInputs): Record<string, unknown> {
  const { entry, events, findings, overlay, kindTerms, templateUrl } = inputs;
  const caseId = entry.caseId as string;
  const kind = entry.kind as string;

  requireEvent(events, ["sabotage.injected", "control.injected"], "the injection stage");
  const reviewEvent = requireEvent(events, ["review.recorded"], "the review stage");
  const adjudicatedEvent = requireEvent(events, ["case.adjudicated"], "the adjudication stage");

  const pr = requireField<{ repo: string; number: number; url: string }>(reviewEvent, "pr", "the review stage");
  const review = requireField<{
    reviewer?: string;
    path?: string;
    configVersion: string;
    reviewedCommit: string;
    reviewedAt: string;
    url: string;
  }>(reviewEvent, "review", "the review stage");

  const disposition = requireField<string>(adjudicatedEvent, "disposition", "the adjudication stage");
  const adjudicatedBy = requireField<string>(adjudicatedEvent, "by", "the adjudication stage");
  const adjudicatedAt = requireField<string>(adjudicatedEvent, "at", "the adjudication stage");

  const overridesById = new Map((overlay.findings ?? []).map((f) => [f.id, f]));
  const publicFindings = findings.map((f) => {
    const override = overridesById.get(f.id);
    return {
      id: `qodo:${f.id}`,
      ...(f.title ? { title: f.title } : {}),
      file: f.file,
      lines: f.lines,
      ...(override?.commentLines ? { commentLines: override.commentLines } : {}),
      category: f.category ?? "",
      severity: override?.severity ?? f.severity ?? "",
      summary: override?.summary ?? f.description ?? "",
    };
  });

  const record: Record<string, unknown> = {
    $schema: SCHEMA_REF,
    schemaVersion: 1,
    caseId,
    kind,
    target: { repo: repoSlug(entry.targetRepo as string), baseCommit: entry.targetCommit },
  };

  if (kind === "sabotage") {
    const injectionLines = entry.injectedLines as [number, number];
    record.injection = {
      templateId: entry.templateId,
      invariantId: entry.invariantId,
      defectClass: entry.defectClass,
      file: entry.injectedFile,
      lines: injectionLines,
      commit: entry.injectionCommit,
      ...(templateUrl ? { template: templateUrl } : {}),
    };
  }

  record.pr = { repo: pr.repo, number: pr.number, url: pr.url };
  record.review = {
    reviewer: review.reviewer ?? REVIEWER,
    path: review.path ?? REVIEW_PATH,
    configVersion: review.configVersion,
    reviewedCommit: review.reviewedCommit,
    reviewedAt: review.reviewedAt,
    url: review.url,
    ...(overlay.review?.linkedRepositories ? { linkedRepositories: overlay.review.linkedRepositories } : {}),
  };
  record.findings = publicFindings;

  if (kind === "sabotage") {
    const injectionLines = entry.injectedLines as [number, number];
    const matchFindings: MatchFinding[] = findings.map((f) =>
      toMatchFinding({
        id: `qodo:${f.id}`,
        file: f.file,
        lines: f.lines,
        title: f.title ?? null,
        category: f.category ?? null,
        description: f.description ?? null,
      }),
    );
    const result = applyMatchRule(
      { file: entry.injectedFile as string, lines: isRange(injectionLines) ? injectionLines : injectionLines },
      matchFindings,
      kindTerms,
    );
    const match = foldedMatch(result.findings, result.matchedFindingIds);
    const overridden = { ...match };
    for (const [key, text] of Object.entries(overlay.detection?.matchDetailOverrides ?? {})) {
      const k = key as "file" | "lines" | "kind";
      overridden[k] = { pass: match[k].pass, detail: text as string };
    }
    record.detection = {
      caught: result.caught,
      matchedFindingIds: result.matchedFindingIds,
      match: overridden,
      ...(overlay.detection?.notes ? { notes: overlay.detection.notes } : {}),
    };
  }

  if (overlay.collateral) record.collateral = overlay.collateral;
  if (overlay.otherReviewers) record.otherReviewers = overlay.otherReviewers;
  if (overlay.challenge) record.challenge = overlay.challenge;

  record.human = { disposition, adjudicatedBy, adjudicatedAt };
  record.status = disposition === "review_incomplete" ? "incomplete" : "complete";

  return record;
}

const OVERLAY_TOP_LEVEL = [
  "detection",
  "collateral",
  "otherReviewers",
  "challenge",
  "review",
  "findings",
  "legacyFindingsPath",
];

/** Problems with an overlay's shape: any field outside the documented, narrow allow-list. */
export function overlayProblems(raw: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!OVERLAY_TOP_LEVEL.includes(key)) problems.push(`overlay sets ${key}, which is not allowed`);
  }
  if (raw.detection && typeof raw.detection === "object") {
    for (const key of Object.keys(raw.detection as object)) {
      if (!["notes", "matchDetailOverrides"].includes(key))
        problems.push(`overlay sets detection.${key}, which is not allowed`);
    }
  }
  if (raw.review && typeof raw.review === "object") {
    for (const key of Object.keys(raw.review as object)) {
      if (key !== "linkedRepositories") problems.push(`overlay sets review.${key}, which is not allowed`);
    }
  }
  if (raw.findings) {
    for (const f of raw.findings as Record<string, unknown>[]) {
      for (const key of Object.keys(f)) {
        if (!["id", "severity", "commentLines", "summary"].includes(key)) {
          problems.push(`overlay sets findings[].${key}, which is not allowed`);
        }
      }
    }
  }
  return problems;
}

/** Dotted paths of the fields this overlay actually sets, for the command to print. */
export function overlayFieldsTaken(raw: Record<string, unknown>): string[] {
  const taken: string[] = [];
  const detection = raw.detection as Record<string, unknown> | undefined;
  if (detection?.notes) taken.push("detection.notes");
  if (detection?.matchDetailOverrides) taken.push("detection.matchDetailOverrides");
  if (raw.collateral) taken.push("collateral");
  if (raw.otherReviewers) taken.push("otherReviewers");
  if (raw.challenge) taken.push("challenge");
  const review = raw.review as Record<string, unknown> | undefined;
  if (review?.linkedRepositories) taken.push("review.linkedRepositories");
  if (raw.findings) taken.push("findings (severity/commentLines overrides)");
  if (raw.legacyFindingsPath) taken.push("legacyFindingsPath");
  return taken;
}

interface CliArgs {
  caseId: string;
  write: boolean;
}

/** The command line, or null when it's wrong. */
export function parseCliArgs(argv: string[]): CliArgs | null {
  const [caseId, ...rest] = argv;
  if (!caseId) return null;
  return { caseId, write: rest.includes("--write") };
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  groundTruthPath?: string;
  auditEventsPath?: string;
  reviewsDir?: string;
  overlayPath?: string;
  examplesDir?: string;
  write?: boolean;
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

const LINE_WIDTH = 120;

function isPrimitive(v: unknown): boolean {
  return v === null || typeof v !== "object";
}

/** A `{ pass, detail }` match criterion: the one object shape this printer tries to keep on one line. */
function isCriterion(v: unknown): v is { pass: boolean; detail: string } {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v as object);
  return keys.length === 2 && keys.includes("pass") && keys.includes("detail");
}

/**
 * Renders JSON the way this repo's published records are written: two-space indent, an array of
 * scalars or a `{ pass, detail }` criterion stay on one line when that fits `LINE_WIDTH`, everything
 * else (objects, and arrays of objects) is one line per property so a diff stays readable.
 */
export function printRecord(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const childPad = "  ".repeat(indent + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every(isPrimitive)) {
      const inline = `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
      if (pad.length + inline.length <= LINE_WIDTH) return inline;
    }
    const items = value.map((v) => `${childPad}${printRecord(v, indent + 1)}`).join(",\n");
    return `[\n${items}\n${pad}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    if (isCriterion(value)) {
      const inline = `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;
      if (pad.length + inline.length <= LINE_WIDTH) return inline;
    }
    const lines = entries.map(([k, v]) => `${childPad}${JSON.stringify(k)}: ${printRecord(v, indent + 1)}`);
    return `{\n${lines.join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(value);
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
  const overlayPath = options.overlayPath ?? join(root, "cases", `${caseId}.overlay.json`);
  const examplesDir = options.examplesDir ?? join(ROOT, "examples");

  let entry: LedgerEntry | undefined;
  let events: LedgerEntry[];
  try {
    entry = readLedger(groundTruthPath).find((e) => e.caseId === caseId);
    events = readAuditLog(auditEventsPath).filter((e) => e.caseId === caseId);
  } catch (e) {
    error(`case:build: can't read ${groundTruthPath} or ${auditEventsPath}: ${message(e)}`);
    return 2;
  }
  if (!entry) {
    error(`case:build: no ground-truth entry for ${caseId} in ${groundTruthPath}`);
    return 2;
  }

  let overlay: Overlay = {};
  try {
    overlay = JSON.parse(readFileSync(overlayPath, "utf8"));
  } catch (e) {
    error(`case:build: can't read ${overlayPath}: ${message(e)}`);
    return 2;
  }
  const overlayIssues = overlayProblems(overlay as Record<string, unknown>);
  if (overlayIssues.length) {
    log(`[case:build] overlay problems:\n${overlayIssues.map((p) => `- ${p}`).join("\n")}`);
    return 1;
  }
  for (const field of overlayFieldsTaken(overlay as Record<string, unknown>))
    log(`[case:build] from overlay: ${field}`);

  const injectionCommit = entry.injectionCommit as string;
  const saved = findSavedReview(reviewsDir, injectionCommit);
  let findings: Finding[];
  if (saved) {
    findings = (saved.review.findings ?? []).map((f) => ({
      id: f.id,
      file: f.file,
      lines: f.lines,
      severity: null,
      category: f.category ?? null,
      title: f.title ?? null,
      description: f.description ?? null,
    }));
  } else if (overlay.legacyFindingsPath) {
    let raw: QodoReview;
    try {
      raw = JSON.parse(readFileSync(join(ROOT, overlay.legacyFindingsPath), "utf8"));
    } catch (e) {
      error(`case:build: can't read ${overlay.legacyFindingsPath}: ${message(e)}`);
      return 2;
    }
    findings = findingsFor(raw, injectionCommit);
  } else {
    error(
      `case:build: no saved review for commit ${injectionCommit} under ${reviewsDir}, and no legacyFindingsPath in the overlay`,
    );
    return 2;
  }

  const templateId = entry.templateId as string | undefined;
  let kindTerms: string[] = [];
  let templateUrl: string | undefined;
  if (templateId) {
    const dir = templateDir(templateId, env);
    if (!dir) {
      error(`case:build: template ${templateId} not found in private/templates or templates/seed`);
      return 2;
    }
    try {
      kindTerms = kindTermsOf(JSON.parse(readFileSync(join(dir, "template.json"), "utf8")), `${dir}/template.json`);
    } catch (e) {
      error(`case:build: can't use ${dir}/template.json: ${message(e)}`);
      return 2;
    }
    if (resolve(dir).startsWith(resolve(ROOT, "templates", "seed"))) {
      templateUrl = `https://github.com/${TEMPLATE_REPO}/tree/main/templates/seed/${templateId}`;
    }
  }

  let record: Record<string, unknown>;
  try {
    record = buildCaseRecord({ entry, events, findings, overlay, kindTerms, templateUrl });
  } catch (e) {
    error(`case:build: ${message(e)}`);
    return 2;
  }

  const problems = [...validateCaseRecord(record), ...findLeaks(JSON.stringify(record))];
  if (problems.length) {
    log(`[case:build] problems found:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    return 1;
  }

  const text = `${printRecord(record)}\n`;
  if (!options.write) {
    log(text.trimEnd());
    return 0;
  }
  const outPath = join(examplesDir, `${caseId}.json`);
  writeFileSync(outPath, text);
  appendFileSync(
    auditEventsPath,
    `${JSON.stringify({
      eventId: `${caseId}-published-${sha256(text).slice(0, 8)}`,
      type: "case.published",
      at: new Date().toISOString(),
      caseId,
      sha256: sha256(text),
      path: `examples/${caseId}.json`,
    })}\n`,
  );
  log(`[case:build] wrote ${outPath}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed) {
    console.error("usage: npm run case:build -- <caseId> [--write]");
    process.exit(2);
  }
  run(parsed.caseId, { write: parsed.write }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`case:build: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}

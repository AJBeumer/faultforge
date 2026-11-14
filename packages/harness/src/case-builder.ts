/**
 * The pure builder behind `case:build`: the public case record from a ground-truth entry, the case's
 * audit events, its findings and its overlay. No file is read here; `case-build.ts` gathers the inputs.
 */
import { recordVersionFor } from "./case-record.ts";
import type { LedgerEntry } from "./ledger.ts";
import { applyMatchRule, type Criterion, type MatchFinding } from "./match-rule.ts";
import type { Finding } from "./qodo-review.ts";
import { toMatchFinding } from "./saved-review.ts";

/** Where a record names its schema, by version (#162: version 2 adds two outcomes a control can have). */
const schemaRef = (version: number) => `../schemas/case-record.v${version}.json`;
/** A record whose overlay says nothing about a challenge says it hasn't run (#162: a control needs no overlay). */
const NOT_CHALLENGED = { verdict: "not_run", note: "Not challenged yet." };

export interface Overlay {
  /** A control's notes; a bug case's go in `detection.notes`. */
  notes?: string[];
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
  /** Where to read findings when no saved review exists, relative to the repo root (an absolute path works too). */
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
  /**
   * The saved review's own `state` ("" when it has none), or null for a legacy review with no save. Read
   * from the save, never from the `review.recorded` event: eight hand-written events carry no state.
   */
  reviewState?: string | null;
}

/** Strips a git remote URL, https or ssh (`git@host:owner/repo`, `ssh://git@host/owner/repo`), to `owner/repo`. */
export function repoSlug(url: string): string {
  return url.replace(/^(?:https?:\/\/|ssh:\/\/[^@/]+@)[^/]+\/|^[^@/\s]+@[^:/]+:/, "").replace(/\.git$/, "");
}

/**
 * The most recent event of `types`, so a later verdict or a re-review is the one that counts. Compared as
 * instants, not as text (`11:00:00Z` is earlier than `11:00:00.500Z`); a tie goes to the later line in the
 * file. An event whose `at` isn't a time is refused, never silently skipped (AUD-N8).
 */
export function latestEvent(events: LedgerEntry[], types: string[], stage: string): LedgerEntry {
  const matches = events.filter((e) => types.includes(e.type as string));
  if (!matches.length) throw new Error(`${stage} is missing: no ${types.join(" or ")} event for this case`);
  const time = (e: LedgerEntry) => {
    const t = Date.parse(e.at as string);
    if (Number.isNaN(t)) throw new Error(`${stage}: event ${String(e.eventId)} has no readable time`);
    return t;
  };
  return matches.reduce((latest, e) => (time(e) >= time(latest) ? e : latest));
}

export function requireField<T>(obj: Record<string, unknown>, field: string, stage: string): T {
  const value = obj[field];
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
  const { entry, events, findings, overlay, kindTerms, templateUrl, reviewState = null } = inputs;
  const caseId = entry.caseId as string;
  const kind = entry.kind as string;

  latestEvent(events, ["sabotage.injected", "control.injected"], "the injection stage");
  const reviewEvent = latestEvent(events, ["review.recorded"], "the review stage") as unknown as Record<
    string,
    unknown
  >;
  const adjudicatedEvent = latestEvent(events, ["case.adjudicated"], "the adjudication stage") as unknown as Record<
    string,
    unknown
  >;

  const pr = requireField<{ repo: string; number: number; url: string }>(reviewEvent, "pr", "the review stage");
  const review = requireField<Record<string, unknown>>(reviewEvent, "review", "the review stage");
  const reviewer = requireField<string>(review, "reviewer", "the review stage");
  const path = requireField<string>(review, "path", "the review stage");
  const configVersion = requireField<string>(review, "configVersion", "the review stage");
  const reviewedCommit = requireField<string>(review, "reviewedCommit", "the review stage");
  const reviewedAt = requireField<string>(review, "reviewedAt", "the review stage");
  const reviewUrl = requireField<string>(review, "url", "the review stage");

  const disposition = requireField<string>(adjudicatedEvent, "disposition", "the adjudication stage");
  const adjudicatedBy = requireField<string>(adjudicatedEvent, "by", "the adjudication stage");
  const adjudicatedAt = requireField<string>(adjudicatedEvent, "at", "the adjudication stage");

  const injectionCommit = entry.injectionCommit as string | undefined;
  if (injectionCommit && reviewedCommit !== injectionCommit) {
    throw new Error(`the review was recorded for commit ${reviewedCommit}, not the injected commit ${injectionCommit}`);
  }
  // A miss, a clean control or a false alarm says the review finished: an unfinished one proves none of them,
  // so only review_incomplete may stand on it (AUD-M1). Checked here, where the record is built, not only
  // where the verdict was asked: four verdicts were written by hand.
  if (reviewState !== null && reviewState !== "complete" && disposition !== "review_incomplete") {
    throw new Error(
      `the saved review's state is ${JSON.stringify(reviewState)}, not "complete", so ${disposition} can't stand on it; only review_incomplete can`,
    );
  }
  const adjudicatedCommit = adjudicatedEvent.commit as string | undefined;
  if (adjudicatedCommit && adjudicatedCommit !== reviewedCommit) {
    throw new Error(`the adjudication is for commit ${adjudicatedCommit}, not the reviewed commit ${reviewedCommit}`);
  }

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
    $schema: schemaRef(recordVersionFor(kind)),
    schemaVersion: recordVersionFor(kind),
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
  } else {
    // What a control changed, from the answer key: no invariant or defect class, since it plants no bug.
    record.change = {
      templateId: entry.templateId,
      file: entry.injectedFile,
      lines: entry.injectedLines,
      commit: entry.injectionCommit,
      ...(templateUrl ? { template: templateUrl } : {}),
    };
  }

  record.pr = { repo: pr.repo, number: pr.number, url: pr.url };
  record.review = {
    reviewer,
    path,
    configVersion,
    reviewedCommit,
    reviewedAt,
    url: reviewUrl,
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
      { file: entry.injectedFile as string, lines: injectionLines },
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

  if (overlay.notes && kind !== "control") throw new Error("overlay sets notes, which only a control may use");
  if (overlay.notes) record.notes = overlay.notes;
  if (overlay.collateral) record.collateral = overlay.collateral;
  if (overlay.otherReviewers) record.otherReviewers = overlay.otherReviewers;
  record.challenge = overlay.challenge ?? NOT_CHALLENGED;

  record.human = { disposition, adjudicatedBy, adjudicatedAt };
  record.status = disposition === "review_incomplete" ? "incomplete" : "complete";

  return record;
}

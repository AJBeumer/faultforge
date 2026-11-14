/**
 * What `verdict` reads before it asks anything: the case's answer-key entry and audit events, the saved
 * review of its commit on its own PR, and its template. Split out of verdict.ts (module size rule).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type LedgerEntry, readAuditLog, readLedger } from "./ledger.ts";
import { ledgerProblemsWithHistory } from "./ledger-check.ts";
import { casePr, findSavedReview, type SavedReview } from "./saved-review.ts";
import { kindTermsOf, templateDir } from "./templates.ts";

export interface VerdictInputs {
  entry: LedgerEntry;
  /** This case's audit events, amendments applied, in file order. */
  caseEvents: LedgerEntry[];
  /** Every case's audit events, for checks across cases. */
  allEvents: LedgerEntry[];
  injectedFile: string;
  injectedLines: [number, number];
  reviewPath: string;
  reviewText: string;
  review: SavedReview & { findings: NonNullable<SavedReview["findings"]> };
  templateText: string;
  kindTerms: string[];
  isControl: boolean;
}

export interface VerdictPaths {
  groundTruthPath: string;
  auditEventsPath: string;
  reviewsDir: string;
  /** Read findings from this file instead of discovering the case's save. */
  reviewPath?: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The inputs, or the reason none can be used (every reason is an exit 2: nothing is written). */
export function loadVerdictInputs(
  caseId: string,
  paths: VerdictPaths,
  env: NodeJS.ProcessEnv,
): VerdictInputs | { problem: string } {
  const { groundTruthPath, auditEventsPath, reviewsDir } = paths;
  // A verdict is appended only to an answer key and audit log whose amendments check out (#192). Checked
  // before anything is read from them: an amendment that changes a case id would hide the case itself.
  const ledgerIssues = ledgerProblemsWithHistory([groundTruthPath, auditEventsPath]);
  if (ledgerIssues.length) {
    return { problem: `the answer key or audit log has problems:\n${ledgerIssues.map((p) => `- ${p}`).join("\n")}` };
  }
  let entries: LedgerEntry[];
  let allEvents: LedgerEntry[];
  try {
    entries = readLedger(groundTruthPath);
    allEvents = readAuditLog(auditEventsPath);
  } catch (e) {
    return { problem: `can't read ${groundTruthPath} or ${auditEventsPath}: ${message(e)}` };
  }
  const entry = entries.find((e) => e.caseId === caseId);
  if (!entry) return { problem: `no ground-truth entry for ${caseId} in ${groundTruthPath}` };
  const { injectedFile, injectedLines, templateId, injectionCommit } = entry;
  if (
    typeof injectedFile !== "string" ||
    !Array.isArray(injectedLines) ||
    typeof templateId !== "string" ||
    typeof injectionCommit !== "string"
  ) {
    return {
      problem: `${caseId}'s ground-truth entry is missing injectedFile, injectedLines, templateId or injectionCommit`,
    };
  }
  const caseEvents = allEvents.filter((e) => e.caseId === caseId);

  let reviewPath = paths.reviewPath;
  let reviewText: string;
  let review: SavedReview;
  if (reviewPath) {
    try {
      reviewText = readFileSync(reviewPath, "utf8");
      review = JSON.parse(reviewText);
    } catch (e) {
      return { problem: `can't read ${reviewPath}: ${message(e)}` };
    }
    if (review.headSha !== injectionCommit) {
      return {
        problem: `${reviewPath} reviewed ${review.headSha}, not ${caseId}'s injected commit ${injectionCommit}`,
      };
    }
  } else {
    // Found by the case's own PR, so another PR's save of the same commit is never the one judged (AUD-M24).
    const pr = casePr(caseEvents);
    if (pr === undefined) {
      return { problem: `${caseId} has no pr.opened event naming its PR, so its saved review can't be found` };
    }
    const found = findSavedReview(reviewsDir, injectionCommit, pr);
    if (!found) {
      return {
        problem: `no saved review.json for commit ${injectionCommit} on PR ${pr} under ${reviewsDir}; run review:wait first`,
      };
    }
    reviewPath = found.path;
    reviewText = found.text;
    review = found.review;
  }
  // No findings list is not "no findings": it is a save this can't judge (AUD-M1).
  if (!Array.isArray(review.findings)) return { problem: `${reviewPath} holds no findings list` };

  const dir = templateDir(templateId, env);
  if (!dir) return { problem: `template ${templateId} not found in private/templates or templates/seed` };
  // A control's template declares no match terms (the schema forbids them): there is no bug to match (#162).
  const isControl = entry.kind === "control";
  let templateText: string;
  let kindTerms: string[] = [];
  try {
    templateText = readFileSync(join(dir, "template.json"), "utf8");
    if (!isControl) kindTerms = kindTermsOf(JSON.parse(templateText), `${dir}/template.json`);
  } catch (e) {
    return { problem: `can't use ${dir}/template.json: ${message(e)}` };
  }
  return {
    entry,
    caseEvents,
    allEvents,
    injectedFile,
    injectedLines: injectedLines as [number, number],
    reviewPath,
    reviewText,
    review: review as VerdictInputs["review"],
    templateText,
    kindTerms,
    isControl,
  };
}

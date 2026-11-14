/**
 * The `inputHash` each tool writes into its audit event, computed in one place, and checked again later
 * (AUD-M26): `inject`'s covers the template, its proofs and the base commit; `verdict`'s covers the
 * answer-key entry, the template and the saved review it judged. A template or a saved review changed
 * after the event no longer gives the recorded hash, and `ledger:check` and `case:build` say so.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type LedgerEntry, readAuditLog, readLedger } from "./ledger.ts";
import { casePr, findSavedReview } from "./saved-review.ts";
import { templateDir } from "./templates.ts";

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** `verdict`'s hash: the entry as it read it (amendments applied, list attached), the template and the save. */
export function verdictInputHash(entry: LedgerEntry, templateText: string, reviewText: string): string {
  return sha256(`${JSON.stringify(entry)}\n${templateText}\n${reviewText}`);
}

/** `inject`'s hash: the template file, each proof file's own hash in order, and the base commit. */
export function injectionInputHash(templateText: string, proofTexts: (string | Buffer)[], baseCommit: string): string {
  return sha256(templateText + proofTexts.map((p) => sha256(p)).join("") + baseCommit);
}

/** The proof files a template's own case is validated with, in the order `inject` hashes them. */
export function ownProofFiles(template: {
  kind?: string;
  proofTest?: string;
  alsoBreaks?: { proofTest: string }[];
}): string[] {
  if (template.kind !== "bug") return [];
  return [template.proofTest as string, ...(template.alsoBreaks ?? []).map((p) => p.proofTest)];
}

/** True for an event a FaultForge tool wrote; a hand-written one (`manual-session`, or none) has no hash to check. */
export function isToolWritten(event: Record<string, unknown>): boolean {
  return typeof event.tool === "string" && event.tool.startsWith("faultforge-harness@");
}

/**
 * Hashes that no longer recompute, for a reason recorded before this check existed. Each is pinned to the
 * hash its inputs give today, so any further change is still reported. FF-0001's template gained its kind
 * terms and a second proof on 10 November, after its verdict (AUD-M11, in the decision log).
 */
export const KNOWN_DRIFT: ReadonlyMap<string, { hash: string; reason: string }> = new Map([
  [
    "15ddfc47-a9d2-47d0-b5c6-bc5a569dbe70",
    {
      hash: "7b0a3712e34a94c4f5ff891a7163f8767a0828a7c8f4d5d7bed8b1cc674ecd2a",
      reason: "FF-0001's template gained its kind terms and a second proof after its verdict",
    },
  ],
]);

/** The template's text and dir, or undefined. */
function templateText(id: unknown, env: NodeJS.ProcessEnv): { dir: string; text: string } | undefined {
  if (typeof id !== "string") return undefined;
  const dir = templateDir(id, env);
  return dir ? { dir, text: readFileSync(join(dir, "template.json"), "utf8") } : undefined;
}

/** What an injection event's hash recomputes to today, or a reason it can't be recomputed. */
export function recomputeInjectionHash(entry: LedgerEntry, env: NodeJS.ProcessEnv): string | { problem: string } {
  const template = templateText(entry.templateId, env);
  if (!template) return { problem: `its template ${String(entry.templateId)} is not found` };
  const files = ownProofFiles(JSON.parse(template.text));
  const missing = files.find((f) => !existsSync(join(template.dir, f)));
  if (missing) return { problem: `its proof ${missing} is not found` };
  return injectionInputHash(
    template.text,
    files.map((f) => readFileSync(join(template.dir, f))),
    String(entry.targetCommit),
  );
}

/** What a verdict's hash recomputes to today, from the save on the case's own PR, or a reason it can't be. */
export function recomputeVerdictHash(
  verdict: LedgerEntry,
  caseEvents: LedgerEntry[],
  groundTruthPath: string,
  reviewsDir: string,
  env: NodeJS.ProcessEnv,
): string | { problem: string } {
  const entry = readLedger(groundTruthPath, verdict.at as string).find((e) => e.caseId === verdict.caseId);
  if (!entry) return { problem: "its answer-key entry is not found" };
  const template = templateText(entry.templateId, env);
  if (!template) return { problem: `its template ${String(entry.templateId)} is not found` };
  const pr = casePr(caseEvents);
  const save = findSavedReview(reviewsDir, String(entry.injectionCommit), pr);
  if (!save) return { problem: `no saved review of ${String(entry.injectionCommit)} on PR ${pr} is found` };
  return verdictInputHash(entry, template.text, save.text);
}

/**
 * Every tool-written injection and verdict event whose `inputHash` no longer recomputes from today's files:
 * a template, proof or saved review changed after the event recorded it.
 */
export function hashProblems(
  paths: { groundTruthPath: string; auditEventsPath: string; reviewsDir: string },
  env: NodeJS.ProcessEnv = process.env,
  drift: ReadonlyMap<string, { hash: string }> = KNOWN_DRIFT,
): string[] {
  const entries = readLedger(paths.groundTruthPath);
  const events = readAuditLog(paths.auditEventsPath);
  const problems: string[] = [];
  for (const event of events) {
    if (!isToolWritten(event) || typeof event.inputHash !== "string") continue;
    const label = `${String(event.caseId)} ${String(event.type)} event ${String(event.eventId)}`;
    let now: string | { problem: string };
    if (event.type === "sabotage.injected" || event.type === "control.injected") {
      const entry = entries.find((e) => e.caseId === event.caseId);
      now = entry ? recomputeInjectionHash(entry, env) : { problem: "its answer-key entry is not found" };
    } else if (event.type === "case.adjudicated") {
      const caseEvents = events.filter((e) => e.caseId === event.caseId);
      now = recomputeVerdictHash(event, caseEvents, paths.groundTruthPath, paths.reviewsDir, env);
    } else continue;
    if (typeof now !== "string") problems.push(`${label}: its inputHash can't be recomputed: ${now.problem}`);
    else if (now !== event.inputHash && drift.get(String(event.eventId))?.hash !== now) {
      problems.push(`${label}: its inputHash no longer recomputes, so an input changed after it was recorded`);
    }
  }
  return problems;
}

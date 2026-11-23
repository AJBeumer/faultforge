/**
 * The rule behind Qodo's "approved" label, as FaultForge reads it, and how the label is judged against our own
 * checks. Pure: `approval-check.ts` and `approval-replay.ts` hand in the facts.
 *
 * Qodo's workflow adds the label when the review of the head has no open finding at Medium or higher and no
 * guard applies. The guards live in Qodo's portal, which no API can read, so `factory.json` keeps a copy
 * (`approval.guards`). If the copy and the portal differ, `approval:check` shows it as a disagreement.
 */
import { posix } from "node:path";

export type ApprovalVerdict = "approved-verified" | "held-for-human" | "not-eligible" | "disagree";

/** The files that match a guard: glob patterns on repo-relative paths, as Node's `path.matchesGlob` reads them. */
export function guardedFiles(files: string[], guards: string[]): string[] {
  return files.filter((file) => {
    const path = file.replaceAll("\\", "/");
    return guards.some((guard) => posix.matchesGlob(path, guard));
  });
}

/** Before any review: a PR that touches a guarded path waits for a person, whatever the review says. */
export function predict(
  files: string[],
  guards: string[],
): { verdict: "held-for-human" | "eligible-if-clean"; guarded: string[] } {
  const guarded = guardedFiles(files, guards);
  return { verdict: guarded.length ? "held-for-human" : "eligible-if-clean", guarded };
}

/**
 * The open findings' labels that stop the label: every label except those the gate only flags (Low). A label
 * the gate doesn't know, or none, stops it too, as it blocks the gate: an older review's "high" is not clean.
 */
export function blockingLevels(levels: (string | null | undefined)[], flag: string[]): string[] {
  return levels.map((level) => level ?? "none").filter((level) => !flag.includes(level));
}

export interface ApprovalFacts {
  labelled: boolean;
  /** Changed files that match a guard. */
  guarded: string[];
  /** Qodo's review of the head finished, and every open finding is one the gate only flags (Low). */
  reviewClean: boolean;
  /** Our `gate:check` on the same saved review (it also counts rounds and unknown labels). */
  gateMet: boolean;
  /** Every CI job the repo requires passed on the head. */
  ciGreen: boolean;
}

export interface ApprovalJudgement {
  verdict: ApprovalVerdict;
  reasons: string[];
}

/** The label is a claim about the head; this says whether our checks back it. */
export function judge(facts: ApprovalFacts): ApprovalJudgement {
  const blockers: string[] = [];
  if (facts.guarded.length) blockers.push(`it touches a guarded path: ${facts.guarded.join(", ")}`);
  if (!facts.reviewClean) blockers.push("Qodo's review of the head is not complete, or has an open finding above Low");
  if (facts.labelled) {
    if (blockers.length)
      return { verdict: "disagree", reasons: ["the label is on a head the workflow should not approve", ...blockers] };
    const unverified: string[] = [];
    if (!facts.gateMet) unverified.push("our gate:check is not met");
    if (!facts.ciGreen) unverified.push("CI is not green on the head");
    if (unverified.length)
      return { verdict: "disagree", reasons: ["the label is on a head our checks don't pass", ...unverified] };
    return { verdict: "approved-verified", reasons: ["labelled, and the review, our gate and CI all agree"] };
  }
  if (facts.guarded.length) return { verdict: "held-for-human", reasons: blockers };
  if (!facts.reviewClean) return { verdict: "not-eligible", reasons: blockers };
  return {
    verdict: "disagree",
    reasons: ["the head meets the workflow's condition and touches no guarded path, but has no label"],
  };
}

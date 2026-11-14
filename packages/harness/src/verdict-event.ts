/** What `verdict` records: the `case.adjudicated` event, and the answers it offers for each kind of case. */

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
  /** The saved review hashed, relative to the answer key's folder (private storage), `/`-separated. */
  reviewFile: string;
  /** The match rule's version (`RULE_VERSION`) for a bug case; a control runs no rule. */
  ruleVersion?: string;
  disposition: string;
  reason: string;
  judgements: Judgement[];
  /** The event id of the earlier verdict this one replaces, given with `--supersede`. */
  supersedes?: string;
}

/** A reason as compared across cases: case, spacing and a closing full stop don't make it another reason. */
export function normalReason(reason: string): string {
  return reason.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");
}

/**
 * Every reason already given for a verdict on another case, and every amended reason, normalised: a reason
 * that fits one case is the wrong reason for another (AUD-H4).
 */
export function reasonsOfOtherCases(events: Record<string, unknown>[], caseId: string): Set<string> {
  const reasons = new Set<string>();
  for (const e of events) {
    if (e.type !== "case.adjudicated" || e.caseId === caseId) continue;
    for (const field of ["reason", "amendedReason"]) {
      const value = e[field];
      if (typeof value === "string" && value.trim()) reasons.add(normalReason(value));
    }
  }
  return reasons;
}

export const BUG_VERDICTS: Record<string, string> = {
  detected: "confirmed_detected",
  missed: "confirmed_missed",
  "review incomplete": "review_incomplete",
};

/**
 * A control has no planted bug to catch (#162): `clean` when Qodo raised nothing, `false alarm` when it
 * raised something on a harmless change, `review incomplete` when the review never finished.
 */
export const CONTROL_VERDICTS: Record<string, string> = {
  clean: "confirmed_clean",
  "false alarm": "confirmed_false_alarm",
  "review incomplete": "review_incomplete",
};

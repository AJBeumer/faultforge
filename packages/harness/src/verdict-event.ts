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

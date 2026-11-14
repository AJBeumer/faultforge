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
  // Closing full stops and the spaces around them go first, then spacing inside (Qodo on PR 267).
  return reason
    .toLowerCase()
    .replace(/[\s.]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every reason already given for a verdict on another case, and every amended reason, normalised: a reason
 * that fits one case is the wrong reason for another (AUD-H4).
 */
export function reasonsOfOtherCases(events: Record<string, unknown>[], caseId: string): Set<string> {
  const reasons = new Set<string>();
  for (const e of events) {
    if (e.type !== "case.adjudicated" || e.caseId === caseId) continue;
    // The amendments too: a reason a later amendment replaced is still that case's (Qodo on PR 267).
    const changes = Array.isArray(e.amendments) ? e.amendments.map((a) => (a as { change?: unknown }).change) : [];
    for (const source of [e, ...changes]) {
      if (typeof source !== "object" || source === null) continue;
      for (const field of ["reason", "amendedReason"]) {
        const value = (source as Record<string, unknown>)[field];
        if (typeof value === "string" && value.trim()) reasons.add(normalReason(value));
      }
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

/**
 * A case's verdict that counts: the latest by `at`, as `case:build` picks it (a tie goes to the later line).
 * `verdict --supersede` and `verdict:amend` name this one, never merely the last line (Qodo on PR 267).
 */
export function latestVerdict<T extends Record<string, unknown>>(caseEvents: T[]): T | undefined {
  let latest: T | undefined;
  for (const e of caseEvents) {
    if (e.type !== "case.adjudicated") continue;
    const at = Date.parse(String(e.at));
    // An unreadable time is refused, as case:build refuses it, never silently ranked (Qodo on PR 267).
    if (Number.isNaN(at)) throw new Error(`verdict ${String(e.eventId)} has no readable time`);
    if (!latest || at >= Date.parse(String(latest.at))) latest = e;
  }
  return latest;
}

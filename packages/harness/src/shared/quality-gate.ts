/**
 * The factory's quality gate: which of a review's open findings must be fixed before a task counts as done,
 * and which are only reported to the owner. The gate itself is data (`gate` in `factory.json`); this module
 * decides it for one saved review and words it for the agent, so the runner, the commands and the agent's
 * instructions can't state three different gates.
 *
 * Everything unknown blocks: a label in neither list, a finding with no label, a record that isn't of the
 * commit asked about, a review that didn't finish, a list of open findings that can't be read, a number of
 * review rounds the record doesn't give when it is required.
 *
 * A finding's title and label are the reviewer's text. Every line this module builds from them goes through
 * `plainText`, so that text can't add a line, move the cursor, colour the terminal, mention someone or link.
 */
import type { QualityGate } from "./factory-config.ts";

/** What the gate reads of one finding: the shape `review:wait` saves in `openFindings`. */
export interface GateFinding {
  id?: string | null;
  title?: string | null;
  severity?: string | null;
  category?: string | null;
  file?: string | null;
}

/** What the gate reads of a saved review (`*.review.json`). */
export interface GateRecord {
  headSha?: unknown;
  state?: unknown;
  openFindings?: unknown;
  /** The review rounds Qodo has run on the pull request; absent in a save made before they were recorded. */
  reviewRounds?: unknown;
}

export interface GateOptions {
  /** The record must be of exactly this commit. */
  head?: string;
  /** The record must say the review finished. */
  requireComplete?: boolean;
  /**
   * "require": the record must give its review rounds, and no more than the gate allows. "if-recorded": the
   * limit is applied when the record gives them, and a record without them doesn't block for that reason.
   * Left out: rounds aren't looked at.
   */
  rounds?: "require" | "if-recorded";
}

export interface GateAccount {
  /** True only with no problem at all. */
  met: boolean;
  /** Open findings the gate says must be fixed. */
  mustFix: GateFinding[];
  /** Open findings whose label the gate doesn't know. They block. */
  unknown: GateFinding[];
  /** Open findings the gate only reports to the owner. They don't block. */
  flagged: GateFinding[];
  /** The review rounds the record gives, or null when it gives none. */
  rounds: number | null;
  /** Why the gate isn't met, one plain sentence each; empty when it is. */
  problems: string[];
}

/** Qodo's own words for its labels, as its review comments show them. */
const PLAIN: Record<string, string> = {
  action_required: "High",
  remediation_recommended: "Medium",
  informational: "Low",
};

/**
 * Text from outside, made safe for one line of a report: control characters (line breaks, carriage returns,
 * escape sequences) become spaces, and characters that could mention, link or mark up become "?".
 */
export function plainText(text: string, max: number): string {
  return (
    text
      // Control characters, and the line and paragraph separators, by their Unicode classes.
      .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
      .replace(/[`@<>[\]()|]/g, "?")
      .replace(/ +/g, " ")
      .trim()
      .slice(0, max)
  );
}

/** A label with Qodo's plain word after it, when it has one: `remediation_recommended (Medium)`. */
export function labelName(label: string): string {
  return PLAIN[label] ? `${label} (${PLAIN[label]})` : label;
}

/** A finding's label as a report shows it: a known one by name, any other reduced to plain characters. */
export function findingLabel(finding: GateFinding): string {
  if (typeof finding.severity !== "string") return "no label";
  if (PLAIN[finding.severity]) return labelName(finding.severity);
  return plainText(finding.severity, 40).replace(/[^\w -]/g, "?") || "no label";
}

/** A finding's title for a report: one bounded line of plain text. */
export function findingTitle(finding: GateFinding): string {
  return plainText(typeof finding.title === "string" ? finding.title : "", 120) || "(untitled)";
}

/** The gate's verdict on a saved review. */
export function gateAccount(
  record: GateRecord | null | undefined,
  gate: QualityGate,
  options: GateOptions = {},
): GateAccount {
  const account: GateAccount = { met: false, mustFix: [], unknown: [], flagged: [], rounds: null, problems: [] };
  if (!record || typeof record !== "object") {
    account.problems.push("there is no saved review to judge");
    return account;
  }
  if (options.head !== undefined && record.headSha !== options.head) {
    const of = typeof record.headSha === "string" ? plainText(record.headSha, 7) : "an unnamed commit";
    account.problems.push(`the saved review is of ${of}, not of ${options.head.slice(0, 7)}`);
  }
  if (options.requireComplete && record.state !== "complete") {
    account.problems.push("the saved review didn't finish, so its findings prove nothing");
  }
  const rounds = record.reviewRounds;
  if (typeof rounds === "number" && Number.isInteger(rounds) && rounds >= 0) account.rounds = rounds;
  if (options.rounds !== undefined) {
    if (account.rounds !== null && account.rounds > gate.maxRounds) {
      account.problems.push(
        `${account.rounds} review rounds have run on the pull request, more than the gate's ${gate.maxRounds}`,
      );
    } else if (account.rounds === null && options.rounds === "require") {
      account.problems.push("the saved review doesn't say how many review rounds have run");
    }
  }
  if (!Array.isArray(record.openFindings)) {
    account.problems.push("the saved review has no readable list of open findings");
    return account;
  }
  for (const entry of record.openFindings) {
    const finding: GateFinding = entry && typeof entry === "object" ? (entry as GateFinding) : {};
    const label = typeof finding.severity === "string" ? finding.severity : null;
    if (label !== null && gate.fix.includes(label)) account.mustFix.push(finding);
    else if (label !== null && gate.flag.includes(label)) account.flagged.push(finding);
    else account.unknown.push(finding);
  }
  for (const label of gate.fix) {
    const open = account.mustFix.filter((f) => f.severity === label);
    if (open.length) {
      account.problems.push(
        `${open.length} ${labelName(label)} finding(s) still open: ${open.map(findingTitle).join("; ")}`,
      );
    }
  }
  if (account.unknown.length) {
    const labels = [
      ...new Set(account.unknown.map((f) => (typeof f.severity === "string" ? findingLabel(f) : "none"))),
    ];
    account.problems.push(
      `${account.unknown.length} open finding(s) with a label the gate doesn't know (${labels.join(", ")}): ${account.unknown
        .map(findingTitle)
        .join("; ")}`,
    );
  }
  account.met = account.problems.length === 0;
  return account;
}

/**
 * The findings an earlier saved review of the pull request listed that the judged review no longer lists as
 * open: closed since. Matched by id; a finding without an id can't be followed and is left out.
 */
export function closedFindings(record: GateRecord, earlier: unknown[]): GateFinding[] {
  const open = new Set(
    (Array.isArray(record.openFindings) ? record.openFindings : [])
      .map((f) => (f && typeof f === "object" ? (f as GateFinding).id : null))
      .filter((id): id is string => typeof id === "string"),
  );
  const closed = new Map<string, GateFinding>();
  for (const other of earlier) {
    if (!other || typeof other !== "object") continue;
    const { findings, openFindings } = other as { findings?: unknown; openFindings?: unknown };
    for (const list of [findings, openFindings]) {
      if (!Array.isArray(list)) continue;
      for (const f of list) {
        const id = f && typeof f === "object" ? (f as GateFinding).id : null;
        if (typeof id === "string" && !open.has(id) && !closed.has(id)) closed.set(id, f as GateFinding);
      }
    }
  }
  return [...closed.values()];
}

/** The gate in words, for the agent's instructions and the docs. One paragraph, built only from the data. */
export function gateText(gate: QualityGate): string {
  const names = (labels: string[]) => labels.map(labelName).join(" or ");
  return [
    `Quality gate (the gate section of factory.json): fix every valid open finding labelled ${names(gate.fix)}, whatever its type (bug, rule violation or requirement gap), each with a test that fails first.`,
    gate.flag.length
      ? `Leave findings labelled ${names(gate.flag)} unchanged and list each one in the PR description for the owner.`
      : "No label is exempt.",
    "A finding with any other label, or none, blocks.",
    "A finding you believe is wrong stays open: put the evidence in the PR description and report stuck, because only the owner settles a disagreement.",
    `At most ${gate.maxRounds} review rounds: the runner counts them from Qodo's own record and doesn't deliver a pull request that took more. If a round closes none of the findings that must be fixed, stop and report stuck.`,
  ].join(" ");
}

/**
 * The account as the lines a person reads: the verdict first, then every finding under its heading. `closed`
 * is the findings earlier saved reviews listed that are no longer open (`closedFindings`), when known.
 */
export function gateReport(account: GateAccount, gate: QualityGate, closed?: GateFinding[]): string[] {
  const line = (f: GateFinding) => `  - [${findingLabel(f)}] ${findingTitle(f)}`;
  const section = (heading: string, findings: GateFinding[]) =>
    findings.length ? [heading, ...findings.map(line)] : [`${heading} none`];
  return [
    account.met ? "Quality gate: MET" : "Quality gate: NOT MET",
    ...account.problems.map((p) => `  - ${p}`),
    `Review rounds: ${account.rounds === null ? "not recorded in this save" : account.rounds} (the gate allows ${gate.maxRounds})`,
    ...section(`Must fix (${gate.fix.map(labelName).join(", ")}), still open:`, account.mustFix),
    ...section("Unknown label, blocks:", account.unknown),
    ...section(
      `Flagged for the owner (${gate.flag.map(labelName).join(", ") || "no label"}), left unchanged:`,
      account.flagged,
    ),
    ...(closed === undefined ? [] : section("Closed since an earlier review of this pull request:", closed)),
  ];
}

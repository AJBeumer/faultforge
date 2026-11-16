/**
 * The factory's quality gate: which of a review's open findings must be fixed before a task counts as done,
 * and which are only reported to the owner. The gate itself is data (`gate` in `factory.json`); this module
 * decides it for one saved review and words it for the agent, so the runner, the commands and the agent's
 * instructions can't state three different gates.
 *
 * Everything unknown blocks: a label in neither list, a finding with no label, a record that isn't of the
 * commit asked about, a review that didn't finish, a list of open findings that can't be read.
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
  /** Why the gate isn't met, one plain sentence each; empty when it is. */
  problems: string[];
}

/** Qodo's own words for its labels, as its review comments show them. */
const PLAIN: Record<string, string> = {
  action_required: "High",
  remediation_recommended: "Medium",
  informational: "Low",
};

/** A label with Qodo's plain word after it, when it has one: `remediation_recommended (Medium)`. */
export function labelName(label: string): string {
  return PLAIN[label] ? `${label} (${PLAIN[label]})` : label;
}

/** A finding's title for a report: one line, bounded, and unable to become a mention, a link or markup. */
export function findingTitle(finding: GateFinding): string {
  const title = typeof finding.title === "string" ? finding.title : "";
  const plain = title
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[`@<>[\]()|]/g, "?")
    .trim()
    .slice(0, 120);
  return plain || "(untitled)";
}

/**
 * The gate's verdict on a saved review. With `head`, the record must be of exactly that commit: a finished
 * review of an older commit says nothing about the code now on the pull request. With `requireComplete`,
 * the record must say the review finished.
 */
export function gateAccount(
  record: GateRecord | null | undefined,
  gate: QualityGate,
  options: { head?: string; requireComplete?: boolean } = {},
): GateAccount {
  const account: GateAccount = { met: false, mustFix: [], unknown: [], flagged: [], problems: [] };
  if (!record || typeof record !== "object") {
    account.problems.push("there is no saved review to judge");
    return account;
  }
  if (options.head !== undefined && record.headSha !== options.head) {
    const of = typeof record.headSha === "string" ? record.headSha.slice(0, 7) : "an unnamed commit";
    account.problems.push(`the saved review is of ${of}, not of ${options.head.slice(0, 7)}`);
  }
  if (options.requireComplete && record.state !== "complete") {
    account.problems.push("the saved review didn't finish, so its findings prove nothing");
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
    const labels = [...new Set(account.unknown.map((f) => (typeof f.severity === "string" ? f.severity : "none")))];
    account.problems.push(
      `${account.unknown.length} open finding(s) with a label the gate doesn't know (${labels
        .map((l) => l.replace(/[^\w-]/g, "?").slice(0, 40))
        .join(", ")}): ${account.unknown.map(findingTitle).join("; ")}`,
    );
  }
  account.met = account.problems.length === 0;
  return account;
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
    `At most ${gate.maxRounds} review rounds. If a round closes none of the findings that must be fixed, stop and report stuck.`,
  ].join(" ");
}

/** The account as the lines a person reads: the verdict first, then every open finding under its heading. */
export function gateReport(account: GateAccount, gate: QualityGate): string[] {
  const line = (f: GateFinding) =>
    `  - [${typeof f.severity === "string" ? labelName(f.severity) : "no label"}] ${findingTitle(f)}`;
  const section = (heading: string, findings: GateFinding[]) =>
    findings.length ? [heading, ...findings.map(line)] : [`${heading} none`];
  return [
    account.met ? "Quality gate: MET" : "Quality gate: NOT MET",
    ...account.problems.map((p) => `  - ${p}`),
    ...section(`Must fix (${gate.fix.map(labelName).join(", ")}), still open:`, account.mustFix),
    ...section("Unknown label, blocks:", account.unknown),
    ...section(
      `Flagged for the owner (${gate.flag.map(labelName).join(", ") || "no label"}), left unchanged:`,
      account.flagged,
    ),
  ];
}

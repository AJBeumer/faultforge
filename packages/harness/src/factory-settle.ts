/**
 * The tick's pure decisions: which ticket goes first, what the agent reported, what the run delivered, and
 * what may be shown where. Split from factory-tick.ts, which may not grow (CLAUDE.md, module size rule);
 * factory-tick.ts exports them again for its callers.
 */
import type { AgentRun } from "./factory-agent.ts";
import type { Verification } from "./factory-verify.ts";
import { telltales } from "./neutral.ts";

export const LABELS = {
  ready: "ready-for-agent",
  working: "agent-working",
  done: "agent-done",
  help: "agent-needs-help",
} as const;

export interface IssueEvent {
  event: string;
  created_at: string;
  actor?: { login: string } | null;
  label?: { name: string } | null;
}

/** Who added `label` most recently, and when, or null if the events never show it being added. */
export function lastLabelled(events: IssueEvent[], label: string): { by: string; at: string } | null {
  const added = events.filter((e) => e.event === "labeled" && e.label?.name === label);
  const last = added.sort((a, b) => a.created_at.localeCompare(b.created_at)).pop();
  return last ? { by: last.actor?.login ?? "(unknown)", at: last.created_at } : null;
}

export interface Candidate {
  repoKey: string;
  github: string;
  number: number;
  title: string;
  labelledAt: string;
  labelledBy: string;
}

/** The ticket labelled longest ago; ties go to the lower repo key, then the lower number. */
export function oldest(candidates: Candidate[]): Candidate | undefined {
  return [...candidates].sort(
    (a, b) => a.labelledAt.localeCompare(b.labelledAt) || a.repoKey.localeCompare(b.repoKey) || a.number - b.number,
  )[0];
}

export interface AgentResult {
  outcome: "ready" | "owner-gate" | "stuck";
  pr: string | null;
  reason: string;
}

/** The agent's last `FACTORY_RESULT {...}` line, or null if it gave none or it doesn't parse. */
export function parseAgentResult(text: string | null | undefined): AgentResult | null {
  const lines = [...(text ?? "").matchAll(/^\s*FACTORY_RESULT\s+(\{.*\})\s*$/gm)];
  const last = lines.pop();
  if (!last?.[1]) return null;
  try {
    const value = JSON.parse(last[1]);
    if (!["ready", "owner-gate", "stuck"].includes(value.outcome)) return null;
    return {
      outcome: value.outcome,
      pr: typeof value.pr === "string" && value.pr ? value.pr : null,
      reason: String(value.reason ?? "").trim() || "(no reason given)",
    };
  } catch {
    return null;
  }
}

/** The PR number when `url` is a pull request of exactly this repo, else null. */
export function prNumber(url: string | null, github: string): number | null {
  const match = url?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/);
  return match?.[1]?.toLowerCase() === github.toLowerCase() ? Number(match[2]) : null;
}

export interface Finish {
  label: typeof LABELS.done | typeof LABELS.help;
  reason: string;
  pr: string | null;
}

/**
 * What the run delivered, from the agent's own report and the runner's independent checks. Anything the
 * runner can't confirm is a stop for the owner, never a success.
 */
export function settle(
  agent: AgentRun,
  result: AgentResult | null,
  verify: (pr: number) => Verification,
  github: string,
  minutes: number,
): Finish {
  if (agent.timedOut)
    return { label: LABELS.help, reason: `hit the time limit of ${minutes} minutes`, pr: agent.lastPr ?? null };
  if (!result) {
    const how = agent.subtype && agent.subtype !== "success" ? ` (${agent.subtype})` : "";
    return {
      label: LABELS.help,
      reason: `the agent ended without a result, exit code ${agent.exitCode}${how}`,
      pr: null,
    };
  }
  if (result.outcome === "stuck") return { label: LABELS.help, reason: result.reason, pr: result.pr };
  if (agent.exitCode !== 0 || (agent.subtype !== null && agent.subtype !== "success")) {
    return {
      label: LABELS.help,
      reason: `the agent reported "${result.outcome}" but exited with code ${agent.exitCode} (${agent.subtype ?? "no result"})`,
      pr: result.pr,
    };
  }
  const number = prNumber(result.pr, github);
  if (number === null) {
    return {
      label: LABELS.help,
      reason: `the agent reported "${result.outcome}" without a pull request in ${github}`,
      pr: null,
    };
  }
  const { problems, ownerGates = [] } = verify(number);
  if (problems.length) {
    return {
      label: LABELS.help,
      reason: `the agent reported "${result.outcome}", but ${problems.join("; ")}`,
      pr: result.pr,
    };
  }
  // The runner's own gates hold a PR the agent called ready (#215).
  const waits = [...(result.outcome === "ready" ? [] : [result.reason]), ...ownerGates];
  return {
    label: LABELS.done,
    reason: waits.length
      ? `waiting for the owner: ${waits.join("; ")}`
      : "the pull request is ready for the owner to merge",
    pr: result.pr,
  };
}

/** The secret names whose values must never reach a log. */
export const SECRET_NAMES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "QODO_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
];

/** Replaces every secret value from the environment (8 characters or longer) with three stars. */
export function redact(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  for (const name of SECRET_NAMES) {
    const value = env[name]?.trim();
    if (value && value.length >= 8) out = out.split(value).join("***");
  }
  return out;
}

/** Text for a ticket comment; in a reviewed repo, anything that would give the lab away is replaced. */
export function safeText(text: string, reviewed: boolean): string {
  if (!reviewed || !telltales(text).length) return text;
  return "The details are in the run log.";
}

/** A sortable run id from the start time and the ticket, e.g. `20261109-093012-target-18`. */
export function runIdFor(now: Date, repoKey: string, number: number): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${repoKey}-${number}`;
}

/**
 * How one tick ended. `failed` is the runner itself failing (an exception, before or after a pick), kept
 * apart from a run that stopped for the owner, so a red Actions run for a runner fault stands out (AUD-M18).
 */
export type TickOutcome = "busy" | "idle" | "refused" | "not-ready" | "done" | "needs-help" | "failed";

/**
 * The tick's exit code for each outcome, as factory-tick.ts's header states it: 1 when the run or the ticket
 * stopped for the owner with `agent-needs-help` (a run that stopped, or a ticket that isn't ready), 3 when the
 * tick itself failed (the ticket, if one was claimed, is labelled `agent-needs-help` too), 0 otherwise. A
 * refused ticket gets no label, so it is 0. 2 is the command line or the environment, before any tick.
 */
export const EXIT_CODES: Record<TickOutcome, 0 | 1 | 3> = {
  busy: 0,
  idle: 0,
  refused: 0,
  "not-ready": 1,
  done: 0,
  "needs-help": 1,
  failed: 3,
};

export function exitCodeFor(outcome: TickOutcome): number {
  return EXIT_CODES[outcome];
}

/**
 * The ticket comment when Qodo's configuration couldn't be confirmed before a run. A fixed sentence: the
 * check's own message and differences can carry text read from private storage or from Qodo's API, so they
 * go to the run log as summaries and never to a ticket (the residue of the 13 November H-3).
 */
export const QODO_CHECK_COMMENT =
  "Stopped before any work started: the reviewer's configuration could not be confirmed to match the recorded snapshot. The run log has the details.";

/** A stop the runner itself words, with nothing in it but its own text: safe to repeat on a ticket. */
export class RunnerStop extends Error {}

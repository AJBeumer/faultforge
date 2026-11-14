/**
 * The agent's part of a factory tick (`factory-tick.ts`), once the ticket is claimed and its workspace built:
 * step 7, run the agent on the ticket's checked text (`runOnTicket`), and step 8, don't take its word for the
 * result: audit what changed while it ran and verify the PR it names (`checkRun`).
 */
import type { AgentRun } from "./factory-agent.ts";
import {
  type AgentResult,
  type Candidate,
  earlierPrsNote,
  type Finish,
  LABELS,
  parseAgentResult,
  prNumber,
  RunnerStop,
  settle,
} from "./factory-settle.ts";
import type { Logger, TickDeps, Workspace } from "./factory-tick-deps.ts";
import { provenanceProblems, type TicketSnapshot, ticketChangeProblems } from "./ticket-snapshot.ts";

/** The claimed ticket and where its run happens. */
export interface ClaimedRun {
  deps: TickDeps;
  ws: Workspace;
  pick: Candidate;
  /** The repository owner: the only one whose words may steer the agent. */
  owner: string;
  runId: string;
  log: Logger;
}

/** What the agent did, and when, for `checkRun`. */
export interface AgentOutcome {
  snapshot: TicketSnapshot;
  agent: AgentRun;
  result: AgentResult | null;
  from: string;
  to: string;
}

/** Runs the agent on the ticket's text as the owner left it, taken now, after the claim. */
export async function runOnTicket(run: ClaimedRun): Promise<AgentOutcome> {
  const { deps, ws, pick, owner, runId, log } = run;
  // The agent works from this exact text, taken after the claim, so nothing added later can steer it.
  const snapshot = deps.snapshot(pick.github, pick.number);
  const late = provenanceProblems(snapshot.provenance, owner);
  if (late.length) throw new RunnerStop(`the ticket changed before the run started: ${late.join("; ")}`);
  // A retried ticket continues the pull request an earlier run left open, rather than open a second.
  // Only a hint: a lookup that fails is logged and the run goes on without it (Qodo on PR 268).
  let found: string[] = [];
  try {
    found = deps.openPrs?.(pick.github, pick.number) ?? [];
  } catch (error) {
    log("error", { message: `couldn't list open pull requests: ${error instanceof Error ? error.message : error}` });
  }
  const earlier = found.filter((url) => prNumber(url, pick.github));
  if (earlier.length) log("earlier-prs", { prs: earlier });
  const ticketFile = deps.writeTicket(ws, earlier.length ? snapshot.text + earlierPrsNote(earlier) : snapshot.text);
  log("ticket-snapshot", { file: ticketFile, characters: snapshot.text.length });

  const from = deps.now().toISOString();
  log("agent-started", { command: `/factory ${pick.repoKey} ${pick.number}` });
  const agent = await deps.runAgent(ws, runId, pick.repoKey, pick.number, ticketFile, log);
  const to = deps.now().toISOString();
  const result = parseAgentResult(agent.resultText);
  log("agent-finished", {
    exitCode: agent.exitCode,
    timedOut: agent.timedOut,
    subtype: agent.subtype,
    costUsd: agent.costUsd,
    turns: agent.turns,
    result,
  });
  return { snapshot, agent, result, from, to };
}

/** How the run ends: the audit's problems, if any, else what the PR's verification settles. */
export function checkRun(run: ClaimedRun, outcome: AgentOutcome, minutes: number): Finish {
  const { deps, ws, pick, owner, log } = run;
  // Effects, not just commands: the policy hook reads command text, which can't catch everything.
  const audit = [
    ...deps.audit(ws, pick, outcome.from, outcome.to),
    ...ticketChangeProblems(outcome.snapshot, deps.snapshot(pick.github, pick.number), owner),
  ];
  log("audited", { from: outcome.from, to: outcome.to, problems: audit });
  const settled = settle(
    outcome.agent,
    outcome.result,
    (pr) => {
      const verification = deps.verifyPr(ws, pick.repoKey, pr);
      log("verified", {
        pr,
        problems: verification.problems,
        revertCheckRecord: verification.revertCheckRecord ?? null,
      });
      return verification;
    },
    pick.github,
    minutes,
  );
  return audit.length
    ? { label: LABELS.help, reason: `the run's audit found: ${audit.join("; ")}`, pr: settled.pr }
    : settled;
}

/**
 * The agent's part of a factory tick (`factory-tick.ts`), once the ticket is claimed and its workspace built:
 * step 7, run the agent on the ticket's checked text (`runOnTicket`), and step 8, don't take its word for the
 * result: audit what changed while it ran, compare the files that decide the check (`factory-check-files.ts`) and
 * verify the PR it names (`checkRun`).
 */
import type { AgentRun } from "./factory-agent.ts";
import { checkFilesProblems } from "./factory-check-files.ts";
import { type ClarifyOutcome, questionsComment } from "./factory-clarify.ts";
import {
  type AgentResult,
  type Candidate,
  earlierPrsNote,
  type Finish,
  LABELS,
  parseAgentResult,
  prNumber,
  RunnerStop,
  safeText,
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
  /** True for a ticket in a reviewed repository, where a comment may not give the lab away. */
  reviewed?: boolean;
}

/** What the agent did, and when, for `checkRun`. */
export interface AgentOutcome {
  snapshot: TicketSnapshot;
  agent: AgentRun;
  result: AgentResult | null;
  from: string;
  to: string;
}

/**
 * Before the build: asks a read-only agent which questions a builder would have to guess at. Returns how the
 * run ends when it has questions (they go to the owner, under their own label) or couldn't check, and null
 * when the build should start. A ticket is asked once: when it already holds the runner's questions,
 * answered or not, the build starts.
 */
export async function clarifyTicket(run: ClaimedRun): Promise<Finish | null> {
  const { deps, ws, pick, owner, runId, log } = run;
  if (!deps.clarify) return null;
  const snapshot = deps.snapshot(pick.github, pick.number);
  const late = provenanceProblems(snapshot.provenance, owner);
  if (late.length) throw new RunnerStop(`the ticket changed before the run started: ${late.join("; ")}`);
  if (snapshot.questions) {
    log("clarify-skipped", {
      reason:
        snapshot.questions === "answered"
          ? "the owner replied to the questions asked earlier"
          : "questions were asked earlier and the owner started the ticket again without a reply",
    });
    return null;
  }
  let outcome: ClarifyOutcome;
  let cost: { costUsd: number | null; turns: number | null } = { costUsd: null, turns: null };
  try {
    const result = await deps.clarify(ws, runId, pick.repoKey, snapshot.text, log);
    outcome = result.outcome;
    cost = { costUsd: result.costUsd, turns: result.turns };
  } catch (error) {
    // The error stays in the run log: it can name a path, and the comment can be on a public ticket.
    log("error", { message: `the clarify step failed: ${error instanceof Error ? error.message : error}` });
    outcome = { kind: "failed", reason: "the agent that checks a ticket could not be run" };
  }
  if (outcome.kind === "none") {
    log("clarified", { result: "no open questions", ...cost });
    return null;
  }
  if (outcome.kind === "questions") {
    const count = outcome.questions.length;
    const comment = questionsComment(outcome.questions, LABELS.ready);
    // On a reviewed repository a comment with a giveaway word is replaced whole by a fixed sentence. The
    // owner would then be asked to answer questions nobody can see, so the ticket needs help instead.
    if (run.reviewed && safeText(comment, true) !== comment) {
      log("clarified", { result: "questions that can't be posted on this ticket", questions: count, ...cost });
      return {
        label: LABELS.help,
        reason: "the questions about this ticket hold a word that can't be posted here; they are in the run's files",
        pr: null,
      };
    }
    log("clarified", { result: "questions for the owner", questions: count, ...cost });
    return {
      label: LABELS.answer,
      reason: `${count} question${count === 1 ? "" : "s"} for the owner before building`,
      pr: null,
      comment,
    };
  }
  log("clarified", { result: "could not check", reason: outcome.reason, ...cost });
  return {
    label: LABELS.help,
    reason: `the ticket couldn't be checked for open questions (${outcome.reason})`,
    pr: null,
  };
}

/** Runs the agent on the ticket's text as the owner left it, taken now, after the claim. */
export async function runOnTicket(run: ClaimedRun): Promise<AgentOutcome> {
  const { deps, ws, pick, owner, runId, log } = run;
  // The agent works from this exact text, taken after the claim, so nothing added later can steer it.
  const snapshot = deps.snapshot(pick.github, pick.number);
  const late = provenanceProblems(snapshot.provenance, owner);
  if (late.length) throw new RunnerStop(`the ticket changed before the run started: ${late.join("; ")}`);
  // A retried ticket continues the pull request an earlier run left open, rather than open a second.
  // Only a hint: a lookup that fails is logged and the run goes on without it.
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
      // Then the files that decide the check, compared by the runner itself at the commit it just verified,
      // before the PR can count. GitHub's PR ref can lag a push, so the verified commit comes first.
      const weakened = checkFilesProblems(deps, ws, pick, pr, verification.head, owner, outcome.from, log);
      return { ...verification, problems: [...weakened, ...verification.problems] };
    },
    pick.github,
    minutes,
  );
  return audit.length
    ? { label: LABELS.help, reason: `the run's audit found: ${audit.join("; ")}`, pr: settled.pr }
    : settled;
}

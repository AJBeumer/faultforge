/**
 * What one factory tick needs from the world (`TickDeps`), and the shapes it hands around: the run's
 * workspace, Qodo's configuration check, the logger, and the run's limits. Every side effect of `tick`
 * (`factory-tick.ts`) is behind `TickDeps`, so its stop paths can be tested with fakes; `factory-deps.ts`
 * gives the real ones.
 */
import type { AgentRun } from "./factory-agent.ts";
import type { EvidencePush } from "./factory-evidence.ts";
import type { HooksReport } from "./factory-hooks.ts";
import type { RelabelProblems } from "./factory-relabel.ts";
import type { Candidate, IssueEvent } from "./factory-settle.ts";
import type { Verification } from "./factory-verify.ts";
import type { RunMode } from "./factory-workspace.ts";
import type { Difference } from "./qodo-check.ts";
import type { TicketSnapshot } from "./ticket-snapshot.ts";

export interface Workspace {
  /** Folder holding this run's worktrees. */
  root: string;
  /** This repo's worktree, where the agent starts. */
  lab: string;
  /** The private repo's worktree, on its own branch; empty in a target ticket's run, which has none (AUD-H2). */
  private: string;
  /** Each repo's `main` commit when the run started. */
  mainAtStart: Record<string, string>;
  /** Fingerprints taken before the agent starts, compared after it stops: the owner's checkouts and the guardrail files. */
  fingerprints: Record<string, string>;
  /** What the hook self-test saw, logged as `hooks-checked` before the agent starts. */
  hooks?: HooksReport;
}

/** What `qodo:check` found: `exitCode` 0 means it matches the snapshot, 1 a difference was found (each
 * one in `differences`), 2 it couldn't be checked at all (no key, no snapshot, an API or parse error).
 * Kept structured, not pre-formatted: a difference's full detail (a rule's name and `content`, its field
 * values) can hold text from private storage, so it never goes to a ticket comment (Qodo on PR 145) or to
 * the run log, which CI prints and uploads from a public repository (#187). Both use `summarizeDifference`;
 * the full detail is in the private `qodo-state` evidence. */
export interface QodoCheckOutcome {
  exitCode: 0 | 1 | 2;
  message: string;
  differences: Difference[];
}

export interface TickDeps {
  now(): Date;
  print(line: string): void;
  lock(): { acquired: boolean; release(): void; refresh?(): void; note?: string };
  /** Actions or the owner's PC: the claim comment records it, and recovery leaves the other's claims alone. */
  mode?: RunMode;
  claimMode?(github: string, number: number): RunMode | null;
  /** The owner's reviewed checkouts without the git-level guard; a local tick refuses to start beside them (#242). */
  unguarded?(): string[];
  /** Open issues (not PRs) with the label, in one repo. */
  labelled(github: string, label: string): { number: number; title: string }[];
  events(github: string, number: number): IssueEvent[];
  ready(repoKey: string, number: number): { title: string; problems: string[] };
  /** The ticket's full text and who wrote, edited and commented on it: its text becomes the agent's instructions. */
  snapshot(github: string, number: number): TicketSnapshot;
  /** Writes the checked ticket text into the workspace for the agent, and returns its path. */
  writeTicket(ws: Workspace, text: string): string;
  /** Open pull requests of the ticket's repo that close it: an earlier run's work. */
  openPrs?(github: string, number: number): string[];
  relabel(github: string, number: number, remove: string[], add: string[]): RelabelProblems;
  comment(github: string, number: number, body: string): void;
  /** Compares Qodo's live configuration with the snapshot, before the workspace (and its hook self-test)
   * is built: a drift in the reviewer is caught before an agent is ever started on it. */
  qodoCheck(runId: string): Promise<QodoCheckOutcome>;
  /** `repoKey` is the ticket's repo: a target ticket's run gets no private worktree (AUD-H2). */
  workspace(runId: string, repoKey: string): Workspace;
  runAgent(
    ws: Workspace,
    runId: string,
    repoKey: string,
    number: number,
    ticketFile: string,
    log: Logger,
  ): Promise<AgentRun>;
  verifyPr(ws: Workspace, repoKey: string, pr: number): Verification;
  /** What actually changed while the agent ran: anything here is a stop for the owner. */
  audit(ws: Workspace, ticket: Candidate, from: string, to: string): string[];
  /** Saves the run log (and the agent's transcript) to the private repo, and publishes what's allowed. */
  saveEvidence(runId: string, ws: Workspace | null): EvidencePush & { file: string };
  cleanup(ws: Workspace): void;
  /** Appends one event to the live run log. */
  record(runId: string, event: object): void;
}

export type Logger = (event: string, detail?: Record<string, unknown>) => void;

export interface TickOptions {
  minutes: number;
  budget: number;
}

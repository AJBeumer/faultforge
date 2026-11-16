/**
 * Runs one gate trial: measures the quality gate by its outcome.
 *
 *   npm run gate:trial -- FF-0012 --gate saved
 *   npm run gate:trial -- FF-0012 --gate first-label-only
 *   npm run gate:trial -- FF-0012 --gate saved --keep     leave the scratch copy in place afterwards
 *
 * For one adjudicated case it makes a scratch copy of the reviewed repository at the case's base commit,
 * applies the case's change uncommitted, and runs the loop in `gate-trial.ts`: Qodo's local review of the
 * uncommitted change, the gate, a builder agent that is told only the ordinary ticket and the findings, and
 * again. When the loop stops, the case's proof tests run. Neither the reviewer nor the builder saw them.
 *
 * Nothing is written to the reviewed repository or its GitHub project: the scratch copy's push address is
 * disabled, and no branch, issue or pull request is made. No finding is dismissed, marked or replied to.
 * A trial is not a case: it adds nothing to the answer key, the audit log or a case record. Its record goes
 * to `<evidence>/gate-trials/`.
 *
 * Only a case the public decision log names can be tried: that leaves out held-out cases and any case
 * without a published verdict.
 *
 * This module is the trial's order of work, with the outside world handed in (`TrialIo`);
 * `gate-trial-real.ts` supplies the real scratch copy, reviewer, builder and proof runs.
 *
 * Exit codes: 0 the trial ran and its record was saved, whatever the result; 1 refused (the case can't be
 * tried, or the builder's instructions would give something away); 2 it could not run (bad arguments, the
 * scratch copy, the reviewer or a proof run failed to start), or an unexpected error stopped it, even while
 * loading (`npm run gate:trial` runs `gate-trial-cli.ts`).
 */
import { parseArgs } from "node:util";
import type { QualityGate } from "../shared/factory-config.ts";
import { CASE_ID } from "../shared/paths.ts";
import type { Outcome } from "../shared/run-outcome.ts";
import { firstLabelOnly } from "./gate-replay.ts";
import {
  type BuilderDecision,
  builderPrompt,
  builderPromptProblems,
  judge,
  type LoopStatus,
  type ProofResult,
  runLoop,
  type TrialFinding,
  type TrialResult,
  type TrialReview,
  type TrialRound,
  type TrialTicket,
} from "./gate-trial.ts";

export const GATES = ["saved", "first-label-only"] as const;
export type GateName = (typeof GATES)[number];

export interface TrialArgs {
  caseId: string;
  gate: GateName;
  keep: boolean;
}

/** The command line, or null when it's wrong. */
export function parseTrialArgs(argv: string[]): TrialArgs | null {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { gate: { type: "string" }, keep: { type: "boolean" } },
      allowPositionals: true,
    });
    const [caseId, ...rest] = positionals;
    if (!caseId || rest.length || !CASE_ID.test(caseId)) return null;
    if (!GATES.includes(values.gate as GateName)) return null;
    return { caseId, gate: values.gate as GateName, keep: Boolean(values.keep) };
  } catch {
    return null;
  }
}

/** The gate a name stands for. */
export function gateNamed(name: GateName, saved: QualityGate): QualityGate {
  return name === "saved" ? saved : firstLabelOnly(saved);
}

/** What a trial needs to know about its case. */
export interface TrialCase {
  caseId: string;
  control: boolean;
  templateId: string;
  targetCommit: string;
  ticket: TrialTicket;
}

/** Pure: the case's facts from the answer key, the audit log and the public decision log, or a refusal. */
export function trialCase(
  caseId: string,
  truth: Record<string, unknown>[],
  events: Record<string, unknown>[],
  publicIds: Set<string>,
): TrialCase | { refusal: string } {
  const entry = truth.find((e) => e.caseId === caseId);
  if (!entry) return { refusal: `${caseId} is not in the answer key` };
  if (!events.some((e) => e.type === "case.adjudicated" && e.caseId === caseId)) {
    return { refusal: `${caseId} has no verdict yet: only an adjudicated case can be tried` };
  }
  // A held-out case, or one whose verdict isn't published, is never named by the public record.
  if (!publicIds.has(caseId)) {
    return { refusal: `${caseId} is not named by the public decision log, so it can't be tried` };
  }
  const created = events.filter((e) => e.type === "case.ticket-created" && e.caseId === caseId).at(-1);
  // `case:ticket` records the ticket it created under `issue`.
  const ticket = created?.issue as Partial<TrialTicket> | undefined;
  if (
    !ticket ||
    typeof ticket.url !== "string" ||
    typeof ticket.title !== "string" ||
    typeof ticket.body !== "string"
  ) {
    return { refusal: `${caseId} has no ticket on record: the reviewer and the builder need the ordinary ticket` };
  }
  if (typeof entry.templateId !== "string" || typeof entry.targetCommit !== "string") {
    return { refusal: `${caseId}'s answer-key entry gives no template and base commit` };
  }
  if (!/^[0-9a-f]{40}$/.test(entry.targetCommit)) return { refusal: `${caseId}'s base commit is not a commit id` };
  return {
    caseId,
    control: entry.kind === "control",
    templateId: entry.templateId,
    targetCommit: entry.targetCommit,
    ticket: { url: ticket.url, title: ticket.title, body: ticket.body },
  };
}

/** One proof the trial runs, before and after the loop. */
export interface TrialProof {
  invariantId: string;
  own: boolean;
}

/** Everything a trial does outside its own logic. `gate-trial-real.ts` gives the real ones. */
export interface TrialIo {
  /** Makes the scratch copy with the case's change applied, uncommitted. */
  prepare: () => Promise<void>;
  /** The proofs the trial will run: the case's own, and every other known one. */
  proofs: () => TrialProof[];
  /** Runs every proof against the scratch copy as it is now, in the order `proofs` gave. */
  runProofs: (stage: "before" | "after") => Promise<Outcome[]>;
  review: (round: number) => Promise<TrialReview>;
  /** Starts the builder with `prompt` and returns its decisions. */
  build: (round: number, prompt: string, mustFix: TrialFinding[]) => Promise<BuilderDecision[]>;
  evidencePasses: (testFile: string) => Promise<boolean>;
  /** The repository's own tests, after the loop. */
  publicTests: () => Promise<Outcome>;
  /** What in the builder's changes points outside the repository; empty when nothing does. */
  changeProblems: () => string[];
  save: (record: TrialRecord) => void;
  log: (line: string) => void;
}

export interface TrialRecord {
  caseId: string;
  kind: "bug" | "control";
  gateName: GateName;
  gate: QualityGate;
  baseCommit: string;
  ticket: string;
  status: LoopStatus;
  rounds: TrialRound[];
  proofs: ProofResult[];
  publicTestsAfter: Outcome;
  /** False when any round's review did not report its finding inventory as complete. */
  inventoryReportedComplete: boolean;
  /** Why the builder's changes make this trial uncountable; empty when they don't. */
  changeProblems: string[];
  result: TrialResult;
  damage: string[];
  note: string;
}

/** Thrown when the builder's instructions would hold a word that gives the lab away: the trial is refused. */
export class LeakRefusal extends Error {}

/**
 * One trial, start to saved record. Throws `LeakRefusal` before the builder is ever started with
 * instructions that would give something away, whether from the ticket or from a finding's own text.
 */
export async function runTrial(
  facts: TrialCase,
  gateName: GateName,
  gate: QualityGate,
  io: TrialIo,
): Promise<TrialRecord> {
  const early = builderPromptProblems(builderPrompt(facts.ticket, gate, []));
  if (early.length) throw new LeakRefusal(early.join("; "));
  await io.prepare();
  const proofs = io.proofs();
  io.log(`Proofs before the loop: ${proofs.length} (${proofs.filter((p) => p.own).length} of the case's own)`);
  const before = await io.runProofs("before");
  const outcome = await runLoop(gate, {
    review: async (round) => {
      io.log(`Round ${round}: review of the uncommitted change…`);
      const review = await io.review(round);
      io.log(`  ${review.complete ? "complete" : "INCOMPLETE"}, ${review.open.length} open finding(s)`);
      return review;
    },
    build: async (round, mustFix) => {
      const prompt = builderPrompt(facts.ticket, gate, mustFix);
      const leaked = builderPromptProblems(prompt);
      if (leaked.length) throw new LeakRefusal(leaked.join("; "));
      io.log(`  builder: ${mustFix.length} finding(s) to act on…`);
      const decisions = await io.build(round, prompt, mustFix);
      io.log(`  builder decided: ${decisions.map((d) => d.decision).join(", ") || "nothing readable"}`);
      return decisions;
    },
    evidencePasses: io.evidencePasses,
  });
  io.log("Proofs after the loop…");
  const after = await io.runProofs("after");
  const results: ProofResult[] = proofs.map((proof, i) => ({
    invariantId: proof.invariantId,
    own: proof.own,
    before: before[i] ?? "not_run",
    after: after[i] ?? "not_run",
  }));
  const publicTestsAfter = await io.publicTests();
  const judged = judge(outcome.status, results, facts.control);
  // A builder whose changes point outside the repository may have seen what it must not: nothing is claimed.
  const changeProblems = io.changeProblems();
  const verdict = changeProblems.length
    ? {
        ...judged,
        result: "inconclusive" as const,
        note: `the builder's changes point outside the repository: ${changeProblems.join("; ")}`,
      }
    : judged;
  const inventoryReportedComplete = outcome.rounds.every((r) => r.inventoryComplete);
  const record: TrialRecord = {
    caseId: facts.caseId,
    kind: facts.control ? "control" : "bug",
    gateName,
    gate,
    baseCommit: facts.targetCommit,
    ticket: facts.ticket.url,
    status: outcome.status,
    rounds: outcome.rounds,
    proofs: results,
    publicTestsAfter,
    inventoryReportedComplete,
    changeProblems,
    result: verdict.result,
    damage: verdict.damage,
    note: verdict.note,
  };
  io.save(record);
  io.log("");
  io.log(`${facts.caseId} under "${gateName}": ${outcome.status}; ${verdict.result}`);
  if (verdict.damage.length) io.log(`  damage: ${verdict.damage.join(", ")}`);
  if (verdict.note) io.log(`  ${verdict.note}`);
  io.log(`  the repository's own tests after the loop: ${publicTestsAfter}`);
  if (!inventoryReportedComplete) {
    io.log("  the reviewer did not report its finding inventory as complete in every round");
  }
  return record;
}

/** The command: `gate-trial-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export async function main(argv: string[]): Promise<number> {
  const args = parseTrialArgs(argv);
  if (!args) {
    console.error(`usage: npm run gate:trial -- <case id> --gate <${GATES.join("|")}> [--keep]`);
    return 2;
  }
  // Loaded here, not at the top: the real io reads private storage and starts processes.
  const { realTrial } = await import("./gate-trial-real.ts");
  const real = realTrial(args);
  if ("refusal" in real) {
    console.error(`gate:trial: ${real.refusal}`);
    return real.code;
  }
  try {
    await runTrial(real.facts, args.gate, real.gate, real.io);
    console.log(`Saved in ${real.recordDir}`);
    return 0;
  } catch (e) {
    if (e instanceof LeakRefusal) {
      console.error(`gate:trial: ${e.message}`);
      return 1;
    }
    console.error(`gate:trial: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  } finally {
    real.cleanup();
  }
}

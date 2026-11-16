/**
 * Measures the clarify step against an answer key: does it ask about a gap that was put in a ticket, and
 * does it stay silent on a ticket that is complete?
 *
 *   npm run clarify:measure
 *
 * It reads a fixed set of made-up tickets from private storage (`<private>/clarify/tickets.json`), half with
 * one known gap and half complete, and runs the real clarify agent on each, in this checkout, read-only.
 * The set and its key live in private storage because the agent reads the repository: a key in a public
 * file would be a key the agent could find.
 *
 * A gap ticket is a hit when at least one question holds one of the ticket's gap terms, which were written
 * down before the run. A complete ticket is right when it gets no question. The record goes to
 * `<evidence>/clarify-measure/`.
 *
 * It runs on the owner's machine only. In CI it refuses: its agent would start without the factory's sandbox.
 *
 * Exit codes: 0 the measurement ran and its record was saved, whatever the result; 2 it could not run (in
 * CI, no ticket set, a set that can't be read, or an unexpected error, even while loading: `npm run
 * clarify:measure` runs `clarify-measure-cli.ts`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFactory } from "../shared/factory-config.ts";
import { evidenceDir, privateDir, ROOT } from "../shared/paths.ts";
import { TOOL } from "../shared/provenance.ts";
import type { ClarifyOutcome, ClarifyRun } from "./factory-clarify.ts";
import { runClarify } from "./factory-clarify-run.ts";

/** One made-up ticket of the set. */
export interface MeasureTicket {
  id: string;
  /** The ticket's text, as the agent is given it. */
  text: string;
  /** For a ticket with a gap: words a question about that gap would hold. Absent or empty for a complete ticket. */
  gapTerms?: string[];
}

export interface MeasureLine {
  id: string;
  kind: "gap" | "complete";
  outcome: ClarifyOutcome["kind"];
  questions: string[];
  /** A gap ticket: a question held a gap term. A complete ticket: no question was asked. */
  right: boolean;
  costUsd: number | null;
}

/** Why a ticket set can't be used, or an empty list. */
export function ticketSetProblems(set: unknown): string[] {
  if (!Array.isArray(set) || !set.length) return ["the ticket set is not a list with tickets in it"];
  const problems: string[] = [];
  const seen = new Set<string>();
  set.forEach((entry, i) => {
    const t = entry as Partial<MeasureTicket> | null;
    if (!t || typeof t.id !== "string" || !t.id || typeof t.text !== "string" || !t.text.trim()) {
      problems.push(`ticket ${i + 1} needs an id and a text`);
      return;
    }
    if (seen.has(t.id)) problems.push(`ticket id ${t.id} is used twice`);
    seen.add(t.id);
    if (
      t.gapTerms !== undefined &&
      (!Array.isArray(t.gapTerms) || t.gapTerms.some((term) => typeof term !== "string" || !term.trim()))
    ) {
      problems.push(`ticket ${t.id}: its gap terms must be a list of words`);
    }
  });
  return problems;
}

/** Pure: one ticket's line from what the clarify step returned. */
export function measureLine(ticket: MeasureTicket, run: ClarifyRun): MeasureLine {
  const terms = (ticket.gapTerms ?? []).map((term) => term.toLowerCase());
  const kind = terms.length ? "gap" : "complete";
  const questions = run.outcome.kind === "questions" ? run.outcome.questions.map((q) => q.question) : [];
  // The whole question, its options included: a gap can be named in the choices.
  const asked =
    run.outcome.kind === "questions"
      ? run.outcome.questions.map((q) => [q.question, ...q.options, q.why ?? ""].join(" ").toLowerCase())
      : [];
  const right =
    kind === "gap" ? asked.some((text) => terms.some((term) => text.includes(term))) : run.outcome.kind === "none";
  return { id: ticket.id, kind, outcome: run.outcome.kind, questions, right, costUsd: run.costUsd };
}

export interface MeasureSummary {
  gapTickets: number;
  gapsAsked: number;
  completeTickets: number;
  completeSilent: number;
  /** Tickets the step could not check at all: counted as neither right nor wrong. */
  failed: number;
  costUsd: number;
}

/** Pure: the totals. A ticket the step couldn't check is counted apart, never as silence. */
export function summariseMeasure(lines: MeasureLine[]): MeasureSummary {
  const checked = lines.filter((l) => l.outcome !== "failed");
  const gaps = checked.filter((l) => l.kind === "gap");
  const complete = checked.filter((l) => l.kind === "complete");
  return {
    gapTickets: gaps.length,
    gapsAsked: gaps.filter((l) => l.right).length,
    completeTickets: complete.length,
    completeSilent: complete.filter((l) => l.right).length,
    failed: lines.length - checked.length,
    costUsd: Math.round(lines.reduce((sum, l) => sum + (l.costUsd ?? 0), 0) * 100) / 100,
  };
}

/** The report's lines. */
export function measureReport(lines: MeasureLine[]): string[] {
  const out = lines.map((l) => {
    const what =
      l.outcome === "failed"
        ? "could not be checked"
        : l.kind === "gap"
          ? l.right
            ? "asked about the gap"
            : `MISSED the gap (${l.questions.length} other question(s))`
          : l.right
            ? "no question, as it should be"
            : `asked ${l.questions.length} question(s) of a complete ticket`;
    return `${l.id}  ${l.kind}  ${what}`;
  });
  const s = summariseMeasure(lines);
  out.push("");
  out.push(`Tickets with a gap: asked about it in ${s.gapsAsked} of ${s.gapTickets}`);
  out.push(`Complete tickets: no question in ${s.completeSilent} of ${s.completeTickets}`);
  if (s.failed) out.push(`Could not be checked: ${s.failed}`);
  out.push(`Cost: ${s.costUsd.toFixed(2)} USD`);
  return out;
}

/**
 * Why the measurement won't run here, or undefined. It starts its agent without the network sandbox a
 * factory run in CI has, so it refuses to run in CI at all: it is for the owner's machine.
 */
export function measureRefusal(env: Record<string, string | undefined>): string | undefined {
  return env.CI || env.GITHUB_ACTIONS
    ? "this runs on the owner's machine only: in CI its agent would start without the factory's sandbox"
    : undefined;
}

/** The command: `clarify-measure-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export async function main(argv: string[]): Promise<number> {
  if (argv.length) {
    console.error("usage: npm run clarify:measure");
    return 2;
  }
  const where = measureRefusal(process.env);
  if (where) {
    console.error(`clarify:measure: ${where}`);
    return 2;
  }
  const priv = privateDir();
  const setFile = join(priv, "clarify", "tickets.json");
  if (!existsSync(setFile)) {
    console.error(`clarify:measure: no ticket set at ${setFile}`);
    return 2;
  }
  let set: MeasureTicket[];
  try {
    set = JSON.parse(readFileSync(setFile, "utf8"));
  } catch {
    console.error(`clarify:measure: ${setFile} is not JSON`);
    return 2;
  }
  const problems = ticketSetProblems(set);
  if (problems.length) {
    console.error(`clarify:measure: ${problems.join("; ")}`);
    return 2;
  }
  const factory = loadFactory();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const recordDir = join(evidenceDir(factory), "clarify-measure", stamp);
  mkdirSync(recordDir, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "clarify-measure-"));
  const lines: MeasureLine[] = [];
  try {
    for (const ticket of set) {
      console.log(`${ticket.id}: asking…`);
      // This checkout, read-only, with private storage denied: the set and its key are in there.
      const ws = { root, lab: ROOT, private: priv, mainAtStart: {}, fingerprints: {} };
      const run = await runClarify(recordDir, ws, ticket.id, ticket.text, () => {});
      lines.push(measureLine(ticket, run));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const record = { tool: TOOL, recordedAt: new Date().toISOString(), lines, summary: summariseMeasure(lines) };
  writeFileSync(join(recordDir, "measure.json"), `${JSON.stringify(record, null, 2)}\n`);
  for (const line of measureReport(lines)) console.log(line);
  console.log(`Saved in ${recordDir}`);
  return 0;
}

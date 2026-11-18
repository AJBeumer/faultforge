/**
 * Draws the factory, from a labelled ticket to `main`, as a Mermaid chart built from its own data: the
 * quality gate and the required CI jobs from `factory.json`, and on every step the number of lab runs that
 * reached it, from the saved run records. A hand-drawn chart drifts from the code; this one can be redrawn.
 *
 *   npm run factory:diagram
 *
 * Reads `<evidence>/factory-runs/<run id>.jsonl` for the lab repository only (`*-faultforge-<n>.jsonl`; the
 * agent's own `.agent.jsonl` transcripts and target runs are left out) and writes `docs/factory-diagram.md`.
 * A record that can't be read is listed as skipped, by file name, and never counted.
 *
 * Exit codes: 0 the page was written; 2 it could not run: no run records were found, `factory.json` could not
 * be read, the page could not be written, or an unexpected error stopped it, even while loading
 * (`npm run factory:diagram` runs `factory-diagram-cli.ts`).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FactoryConfig, gateOf, loadFactory, type QualityGate } from "../shared/factory-config.ts";
import { parseJsonLines } from "../shared/jsonl.ts";
import { evidenceDir, ROOT } from "../shared/paths.ts";
import type { RunEvent } from "./factory-timeline.ts";

const LAB = "faultforge";

export interface RunRecord {
  id: string;
  events: RunEvent[];
}

export interface Skipped {
  file: string;
  reason: string;
}

/** Where a run that did not end as `agent-done` stopped, and the runner's reason. */
export interface Stop {
  id: string;
  where: "label" | "ticket" | "questions" | "agent" | "audit" | "verify" | "error";
  reason: string;
}

export interface Stats {
  runs: number;
  first: string | null;
  last: string | null;
  refused: number;
  notReady: number;
  claimed: number;
  preflightFailed: number;
  clarified: number;
  questions: number;
  built: number;
  checkFailures: number;
  ciWaitRuns: number;
  prRuns: number;
  reviewRuns: number;
  reReviews: number;
  revertRuns: number;
  agentReady: number;
  agentStuck: number;
  agentNoResult: number;
  auditProblems: number;
  verified: number;
  verifyProblems: number;
  done: number;
  stops: Stop[];
}

const has = (events: RunEvent[], name: string) => events.some((e) => e.event === name);
const find = (events: RunEvent[], name: string) => events.find((e) => e.event === name);
const problemsOf = (e: RunEvent | undefined) => (Array.isArray(e?.problems) ? (e.problems as unknown[]) : []);
const stepResults = (events: RunEvent[], step: string) =>
  events.filter(
    (e) =>
      e.event === "agent-step-result" &&
      String(e.step ?? "")
        .split("+")
        .includes(step),
  );

function agentOutcome(events: RunEvent[]): string | null {
  const result = find(events, "agent-finished")?.result as { outcome?: unknown } | undefined;
  return typeof result?.outcome === "string" ? result.outcome : null;
}

function agentReason(events: RunEvent[]): string {
  const result = find(events, "agent-finished")?.result as { reason?: unknown } | undefined;
  return typeof result?.reason === "string" ? result.reason : "";
}

/** The one place a run stopped, or null when it ended as `agent-done`. Audit is reported before verify. */
function stopOf(run: RunRecord): Stop | null {
  const { id, events } = run;
  const finished = find(events, "finished");
  const reason = typeof finished?.reason === "string" ? finished.reason : "";
  if (finished?.label === "agent-done") return null;
  const refused = find(events, "refused");
  if (refused) return { id, where: "label", reason: String(refused.reason ?? "") };
  const notReady = find(events, "not-ready");
  if (notReady) return { id, where: "ticket", reason: problemsOf(notReady).join("; ") };
  if (finished?.label === "needs-owner-answer") return { id, where: "questions", reason };
  if (problemsOf(find(events, "audited")).length) return { id, where: "audit", reason };
  if (problemsOf(find(events, "verified")).length) return { id, where: "verify", reason };
  if (finished) return { id, where: "agent", reason: agentReason(events) || reason };
  const error = find(events, "error");
  return { id, where: "error", reason: String(error?.message ?? "the run ended without a result") };
}

export function runStats(runs: RunRecord[]): Stats {
  const count = (test: (events: RunEvent[]) => boolean) => runs.filter((r) => test(r.events)).length;
  const sum = (value: (events: RunEvent[]) => number) => runs.reduce((n, r) => n + value(r.events), 0);
  const times = runs
    .map((r) => r.events[0]?.t)
    .filter((t): t is string => typeof t === "string")
    .sort();
  const stops = runs.map(stopOf).filter((s): s is Stop => s !== null);
  return {
    runs: runs.length,
    first: times[0] ?? null,
    last: times.at(-1) ?? null,
    refused: count((e) => has(e, "refused")),
    notReady: count((e) => has(e, "not-ready")),
    claimed: count((e) => has(e, "claimed")),
    preflightFailed: count((e) =>
      e.some((x) => (x.event === "qodo-checked" && x.exitCode !== 0) || (x.event === "hooks-checked" && x.ok !== true)),
    ),
    clarified: count((e) => has(e, "clarified") || has(e, "clarify-skipped")),
    questions: count((e) => e.some((x) => x.event === "clarified" && x.result === "questions for the owner")),
    built: count((e) => has(e, "agent-started")),
    checkFailures: sum((e) => stepResults(e, "check").filter((x) => x.error === true).length),
    ciWaitRuns: count((e) => stepResults(e, "ci-wait").length > 0),
    prRuns: count((e) => stepResults(e, "pr-opened").some((x) => x.error !== true)),
    reviewRuns: count((e) => stepResults(e, "review-wait").length > 0),
    reReviews: sum((e) => Math.max(0, stepResults(e, "review-wait").length - 1)),
    revertRuns: count((e) => stepResults(e, "revert-check").length > 0),
    agentReady: count((e) => agentOutcome(e) === "ready"),
    agentStuck: count((e) => agentOutcome(e) === "stuck"),
    agentNoResult: count((e) => has(e, "agent-finished") && agentOutcome(e) === null),
    auditProblems: count((e) => problemsOf(find(e, "audited")).length > 0),
    verified: count((e) => has(e, "verified")),
    verifyProblems: count((e) => problemsOf(find(e, "verified")).length > 0),
    done: count((e) => find(e, "finished")?.label === "agent-done"),
    stops,
  };
}

/** A Mermaid label: quotes and pipes would end it early. */
const label = (text: string) => `"${text.replace(/"/g, "#quot;").replace(/\|/g, "#124;")}"`;

export function mermaid(s: Stats, gate: QualityGate, ciJobs: string[]): string {
  const stoppedAt = (where: Stop["where"]) => s.stops.filter((x) => x.where === where).length;
  const agentStops = stoppedAt("agent");
  return [
    "flowchart TD",
    `  T[${label(`Owner labels a ticket ready-for-agent<br/>${s.runs} runs picked one up`)}] --> L{${label("Label added by the owner?")}}`,
    `  L -- ${label(`no: ${s.refused}`)} --> X[${label("Refused, nothing built")}]`,
    `  L -- yes --> R{${label("ticket:ready<br/>every section, a Done when checklist,<br/>no open blockers")}}`,
    `  R -- ${label(`no: ${s.notReady}`)} --> OT{{${label("Owner rewrites the ticket")}}}`,
    "  OT -.-> T",
    `  R -- ${label(`yes: ${s.claimed} claimed`)} --> P{${label(`Pre-flight<br/>Qodo's configuration matches its snapshot,<br/>the guard hooks answer as tested<br/>failed: ${s.preflightFailed}`)}}`,
    `  P --> W[${label("PLANNED: Codebase Wisdom checks<br/>the ticket's claims about the code")}]:::planned`,
    `  P --> C{${label(`Questions before the build<br/>read-only agent: what would a builder guess?<br/>asked in ${s.clarified} runs`)}}`,
    "  W -.-> C",
    `  C -- ${label(`questions: ${s.questions}`)} --> OQ{{${label("Owner answers, re-labels")}}}`,
    "  OQ -.-> T",
    `  C -- ${label(`none: ${s.built} builds`)} --> B[${label("Agent builds test-first<br/>in a sandbox with a network allow-list")}]`,
    `  B --> K{${label("npm run check<br/>typecheck, lint, tests, docs")}}`,
    `  K -- ${label(`fail: ${s.checkFailures} times`)} --> B`,
    `  K -- pass --> LR[${label("PLANNED: Qodo local review of<br/>staged and unstaged changes<br/>review:local, run by hand today")}]:::planned`,
    `  K -- pass --> CW{${label(`ci:wait, scratch branch, no PR<br/>${ciJobs.join(",<br/>")}<br/>used in ${s.ciWaitRuns} runs`)}}`,
    "  LR -.-> CW",
    "  CW -- red --> B",
    `  CW -- green --> PR[${label(`Push, open or update the PR<br/>PR opened in ${s.prRuns} runs`)}]`,
    `  PR --> RW{${label(`review:wait<br/>Qodo's review of the head commit is complete<br/>${s.reviewRuns} runs`)}}`,
    `  RW --> G{${label(`Quality gate, factory.json<br/>fix: ${gate.fix.join(", ") || "none"}<br/>flag for the owner: ${gate.flag.join(", ") || "none"}<br/>at most ${gate.maxRounds} review rounds`)}}`,
    `  RR[${label("NOT USED: Review Resolver<br/>findings come from Qodo's API through review:wait;<br/>marking them in Qodo is against the project rules")}]:::planned`,
    "  RR -.-> G",
    `  G -- ${label(`must-fix open, rounds left<br/>re-reviews: ${s.reReviews}`)} --> B`,
    `  G -- clear --> RC{${label(`revert:check<br/>the new tests fail without the change<br/>${s.revertRuns} runs`)}}`,
    "  RC -- fail --> B",
    `  RC -- pass --> AR[${label(`Agent reports ready: ${s.agentReady}`)}]`,
    `  G -- ${label("round limit, budget or time")} --> AS[${label(`Agent reports stuck: ${s.agentStuck}<br/>no result: ${s.agentNoResult}`)}]`,
    `  AR --> AU{${label("Runner's audit<br/>main didn't move, nothing posted,<br/>the ticket didn't change")}}`,
    "  AS --> AU",
    `  AU -- ${label(`problems: ${s.auditProblems}`)} --> H{{${label("agent-needs-help<br/>the owner decides: fix, allow a round, or close")}}}`,
    `  AU -- ${label(`agent stuck: ${agentStops}`)} --> H`,
    `  AU -- ${label(`ready: ${s.verified} verified`)} --> V{${label("Runner's verify, from a trusted main<br/>PR open at the pushed head, required checks green,<br/>review record of the head, gate met, revert:check")}}`,
    `  V -- ${label(`problems: ${s.verifyProblems}`)} --> H`,
    `  B -. ${label(`runner error: ${stoppedAt("error")}`)} .-> H`,
    `  V -- ${label(`ok: ${s.done}`)} --> D{{${label("agent-done<br/>the owner checks the criteria and merges")}}}`,
    "  D --> M[(main)]",
    "  classDef planned stroke-dasharray: 5 5",
  ].join("\n");
}

const WHERE: Record<Stop["where"], string> = {
  label: "label check",
  ticket: "ticket:ready",
  questions: "questions before the build",
  agent: "agent's own loop",
  audit: "runner's audit",
  verify: "runner's verify",
  error: "runner error",
};

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 160);

export function diagramDoc(s: Stats, config: FactoryConfig, skipped: Skipped[]): string {
  const gate = gateOf(config);
  const ciJobs = config.repos[LAB]?.ciJobs ?? [];
  const range = s.first && s.last ? `${s.first.slice(0, 10)} to ${s.last.slice(0, 10)}` : "no dates";
  return [
    "# The factory, drawn from its own data",
    "",
    `Generated by \`npm run factory:diagram\` from ${s.runs} lab run records (${range}, UTC) and \`factory.json\`. Do not edit by hand; run the command again.`,
    'Each number counts runs, except "fail" and "re-reviews", which count events. Dashed steps are not part of the factory\'s runs today.',
    skipped.length
      ? `Skipped, not readable: ${skipped.map((x) => `\`${x.file}\` (${cell(x.reason)})`).join(", ")}.`
      : "No run record was skipped.",
    "",
    "```mermaid",
    mermaid(s, gate, ciJobs),
    "```",
    "",
    "## The gates",
    "",
    "| Gate | What must pass | Evidence it reads | When it fails |",
    "|---|---|---|---|",
    "| Label | The owner added `ready-for-agent` | The issue's label events | Refused, nothing built |",
    "| `ticket:ready` | Every required section, a checklist, no open blockers | The ticket | Back to the owner |",
    "| Pre-flight | Qodo's configuration is the recorded one; the guard hooks answer as tested | `qodo:check`, a hook self-test | The run stops |",
    "| Questions | No question a builder would have to guess | A read-only agent's answer | Questions posted; the owner answers |",
    "| `npm run check` | Typecheck, lint, tests, docs | The command's exit code | Back to the build |",
    `| \`ci:wait\` | ${ciJobs.map((j) => `\`${j}\``).join(", ")} | The jobs' results on a scratch branch | Back to the build, no review round spent |`,
    "| `review:wait` | Qodo's review of the head commit is complete | Qodo's API | No verdict until it is |",
    `| Quality gate | Nothing open labelled ${gate.fix.map((f) => `\`${f}\``).join(" or ")}, within ${gate.maxRounds} rounds | Qodo's saved record of the head | A fix round, or stuck at the limit |`,
    "| `revert:check` | The new tests fail without the change | The tests run on the base | Back to the build |",
    "| Audit | `main` didn't move, nothing was posted, the ticket didn't change | GitHub's history for the run's window | `agent-needs-help` |",
    "| Verify | All of the above, rechecked by the runner from a trusted `main` | GitHub and the saved records | `agent-needs-help` |",
    "| Merge | The owner's decision | The PR and its evidence | The owner sends it back |",
    "",
    "## Where runs stopped",
    "",
    `${s.done} of ${s.runs} runs ended as \`agent-done\`. The others stopped at one place each, the first the runner reports.`,
    "",
    "| Run | Stopped at | Reason |",
    "|---|---|---|",
    ...s.stops.map((x) => `| \`${x.id}\` | ${WHERE[x.where]} | ${cell(x.reason)} |`),
    "",
  ].join("\n");
}

const LAB_RUN = new RegExp(`^\\d{8}-\\d{6}-${LAB}-\\d+\\.jsonl$`);

export function readRuns(dir: string): { runs: RunRecord[]; skipped: Skipped[] } {
  const runs: RunRecord[] = [];
  const skipped: Skipped[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => LAB_RUN.test(f))
    .sort()) {
    try {
      const events = parseJsonLines<RunEvent>(readFileSync(join(dir, file), "utf8"));
      if (!events.length || events.some((e) => typeof e?.event !== "string")) throw new Error("no events");
      runs.push({ id: file.replace(/\.jsonl$/, ""), events });
    } catch (error) {
      skipped.push({ file, reason: (error as Error).message });
    }
  }
  return { runs, skipped };
}

export function main(_args: string[], root: string = ROOT): number {
  const config = loadFactory();
  const dir = join(evidenceDir(config, root), "factory-runs");
  if (!existsSync(dir)) {
    console.error(`factory:diagram: no run records at ${dir}`);
    return 2;
  }
  const { runs, skipped } = readRuns(dir);
  if (!runs.length) {
    console.error(`factory:diagram: no readable lab run records in ${dir}`);
    return 2;
  }
  const out = join(root, "docs", "factory-diagram.md");
  writeFileSync(out, diagramDoc(runStats(runs), config, skipped));
  console.log(`factory:diagram: ${runs.length} runs counted, ${skipped.length} skipped; wrote ${out}`);
  return 0;
}

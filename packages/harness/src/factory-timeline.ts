/**
 * Prints a factory run's log as a Markdown table, for the PR, the decision log or a post.
 *
 *   npm run factory:timeline -- 20261109-093012-target-18
 *   npm run factory:timeline -- latest
 *
 * Reads `<runs>/<run id>.jsonl` (the live log), or the copy under `<evidence>/factory-runs/`.
 *
 * Exit codes: 0 the timeline was printed; 2 no run id was given, or no log for it was found.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceDir, runsDir } from "./paths.ts";

export interface RunEvent {
  t: string;
  event: string;
  [key: string]: unknown;
}

const SKIP = new Set(["t", "event"]);

function describe(event: RunEvent): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(event)) {
    if (SKIP.has(key) || value === null || value === undefined) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}: ${text}`);
  }
  return parts.join(", ").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 400);
}

/** The run as a Markdown table: UTC time, minutes since the first event, event and details. */
export function timeline(events: RunEvent[]): string {
  if (!events.length) return "(empty run log)";
  const start = Date.parse(events[0]?.t ?? "");
  const rows = events.map((e) => {
    const minutes = ((Date.parse(e.t) - start) / 60_000).toFixed(1);
    return `| ${e.t.slice(11, 19)} | +${minutes} | ${e.event} | ${describe(e)} |`;
  });
  return [
    `Run started ${events[0]?.t.slice(0, 10)} (UTC)`,
    "",
    "| UTC | Min | Event | Detail |",
    "|---|---:|---|---|",
    ...rows,
  ].join("\n");
}

export function parseLog(text: string): RunEvent[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RunEvent);
}

function minutesBetween(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  const diff = (Date.parse(toIso) - Date.parse(fromIso)) / 60_000;
  return Number.isNaN(diff) ? null : diff;
}

function fmtMinutes(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)} min`;
}

function fmtCost(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(2)}`;
}

function fmtCount(value: number | null, word: string): string {
  if (value === null) return `n/a ${word}s`;
  return `${value} ${word}${value === 1 ? "" : "s"}`;
}

/**
 * One line summing up a run: label to result, waiting, agent time, cost, turns and review rounds,
 * and how it ended. A run with no `finished` event (refused or not ready) only has waiting and the
 * outcome: there was no agent run to measure.
 */
export function summarize(events: RunEvent[]): string {
  const picked = events.find((e) => e.event === "picked");
  const labelledAt = typeof picked?.labelledAt === "string" ? picked.labelledAt : null;
  const waiting = minutesBetween(labelledAt, typeof picked?.t === "string" ? picked.t : null);

  const finished = events.find((e) => e.event === "finished");
  if (!finished) {
    const stop = events.find((e) => e.event === "refused" || e.event === "not-ready");
    return `Summary: waiting ${fmtMinutes(waiting)}, outcome ${stop?.event ?? "n/a"}`;
  }

  const started = events.find((e) => e.event === "agent-started");
  const agentDone = events.find((e) => e.event === "agent-finished");
  const labelToResult = minutesBetween(labelledAt, typeof finished.t === "string" ? finished.t : null);
  const agentMinutes = minutesBetween(
    typeof started?.t === "string" ? started.t : null,
    typeof agentDone?.t === "string" ? agentDone.t : null,
  );
  const cost = typeof agentDone?.costUsd === "number" ? agentDone.costUsd : null;
  const turns = typeof agentDone?.turns === "number" ? agentDone.turns : null;
  const reviewRounds = events.filter((e) => e.event === "agent-step" && e.step === "review-wait").length;
  const outcome = typeof finished.label === "string" ? finished.label : "n/a";

  return (
    `Summary: label to result ${fmtMinutes(labelToResult)}, waiting ${fmtMinutes(waiting)}, ` +
    `agent ${fmtMinutes(agentMinutes)}, cost ${fmtCost(cost)}, ${fmtCount(turns, "turn")}, ` +
    `${fmtCount(reviewRounds, "review round")}, outcome ${outcome}`
  );
}

function main() {
  const runs = runsDir();
  const saved = join(evidenceDir(), "factory-runs");
  const [arg] = process.argv.slice(2);
  if (!arg) {
    console.error("usage: npm run factory:timeline -- <run id | latest>");
    process.exit(2);
  }
  const logs = (dir: string) =>
    existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{8}-\d{6}-.+(?<!\.agent)\.jsonl$/.test(f)) : [];
  const id =
    arg === "latest"
      ? [...logs(runs), ...logs(saved)]
          .sort()
          .pop()
          ?.replace(/\.jsonl$/, "")
      : arg;
  const file = [join(runs, `${id}.jsonl`), join(saved, `${id}.jsonl`)].find((f) => existsSync(f));
  if (!id || !file) {
    console.error(`No run log for ${arg} in ${runs} or ${saved}`);
    process.exit(2);
  }
  console.log(`### Factory run ${id}\n`);
  const events = parseLog(readFileSync(file, "utf8"));
  console.log(timeline(events));
  console.log("");
  console.log(summarize(events));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();

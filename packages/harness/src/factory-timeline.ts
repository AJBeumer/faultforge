/**
 * Prints a factory run's log as a Markdown table, for the PR, the decision log or a post.
 *
 *   npm run factory:timeline -- 20261109-093012-target-18
 *   npm run factory:timeline -- latest
 *
 * Reads `<runs>/<run id>.jsonl` (the live log), or the copy under `<evidence>/factory-runs/`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFactory } from "./factory-config.ts";

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

function main() {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const runs = resolve(process.env.FAULTFORGE_RUNS_DIR ?? join(root, "..", "faultforge-runs"));
  const saved = join(root, loadFactory().evidence, "factory-runs");
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
  console.log(timeline(parseLog(readFileSync(file, "utf8"))));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();

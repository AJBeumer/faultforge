/**
 * Shows what the next factory tick's recovery would change, and changes nothing: which `agent-working`
 * tickets it would move to `agent-needs-help` (or only clear), which it would leave to the other way of
 * running, and whether it would take over the run lock and end a gone runner's agent.
 *
 *   npm run factory:recover -- --dry-run              # as a tick on this machine would see it
 *   npm run factory:recover -- --dry-run --mode ci    # as a tick in GitHub Actions would see it
 *
 * There is no other mode: the real recovery runs only inside a tick, under the run lock. `--dry-run` is
 * required so the command line says what it does. It makes the same GitHub reads a tick makes
 * (`githubRecoveryReads`), runs `recoverStranded` with `dryRun`, which never calls a write, and reads the
 * lock file without touching it. Safe to run against the real repos while a tick runs.
 *
 * Exit codes: 0 the report is complete, whether or not anything would change; 1 the report is incomplete: a
 * repo's tickets, or a ticket's claim, couldn't be read (each one is listed); 2 it couldn't run: a bad
 * command line (no `--dry-run`, an unknown mode), a config that doesn't load, or an unexpected error.
 * `npm run factory:recover` runs `factory-recover-cli.ts`, so an unexpected error, even while loading, is 2.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadFactory } from "./factory-config.ts";
import { readBeat } from "./factory-lock.ts";
import { sameProcess } from "./factory-process.ts";
import {
  githubRecoveryReads,
  lockIsStale,
  pidAlive,
  type RecoveryDeps,
  type RecoveryReport,
  recoverStranded,
} from "./factory-recovery.ts";
import type { RunMode } from "./factory-workspace.ts";
import { runsDir } from "./paths.ts";

/** How the lock check sees processes; the tests give fakes. */
export interface ProcessView {
  isAlive(pid: number): boolean;
  isSame(pid: number, started: string | undefined): boolean;
}

const realProcesses: ProcessView = { isAlive: pidAlive, isSame: (pid, started) => sameProcess(pid, started) };

/**
 * What a tick would do with the run lock in `dir`, in words, by the rules `acquireLock` applies: a live
 * holder keeps it; a gone one's lock is taken over, its agent ended first when that pid is still the agent.
 * Only reads.
 */
export function describeLock(dir: string, processes: ProcessView = realProcesses): string {
  const file = join(dir, "factory.lock");
  if (!existsSync(file)) return "no tick holds the run lock: a tick would take it";
  let held: { pid?: number; started?: string; since?: string; at?: string; token?: string };
  try {
    held = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return "the run lock can't be read, so it names no holder: a tick would take it over";
  }
  const beat = readBeat(dir, held.token);
  const last = beat.at ?? held.at ?? "unknown";
  if (!lockIsStale(held, processes.isAlive, processes.isSame)) {
    return `held by a live tick (pid ${held.pid}, since ${held.since ?? held.at ?? "unknown"}, last heartbeat ${last}): a tick would wait`;
  }
  const why = held.pid && processes.isAlive(held.pid) ? "its pid is now another process" : "its holder is gone";
  const agent =
    beat.agentPid && processes.isAlive(beat.agentPid)
      ? `, after ending its agent (pid ${beat.agentPid}) if that pid is still the agent; if that can't be told, the lock would stay`
      : "";
  return `stale (pid ${held.pid ?? "?"}, last heartbeat ${last}; ${why}): a tick would take it over${agent}`;
}

/** What the dry run needs from the world; `main` gives the real ones. */
export interface DryRunDeps {
  repos: { github: string }[];
  reads: Pick<RecoveryDeps, "labelled" | "claimMode">;
  lockDir: string;
  processes?: ProcessView;
  now(): Date;
  print(line: string): void;
}

/** A write in a dry run is a bug: it throws instead of reaching GitHub. */
function refuseWrite(): never {
  throw new Error("a dry run never writes");
}

/** The report, as lines. Returns the exit code. */
export function dryRun(mode: RunMode, deps: DryRunDeps): number {
  const writes: Pick<RecoveryDeps, "comment" | "relabel"> = { comment: refuseWrite, relabel: refuseWrite };
  const report: RecoveryReport = recoverStranded(deps.repos, { ...deps.reads, ...writes, mode }, { dryRun: true });
  const out = deps.print;
  out(`[factory:recover] dry run at ${deps.now().toISOString()}, as a ${mode} tick would see it; nothing is written`);
  out(`repos: ${deps.repos.map((r) => r.github).join(", ")}`);
  out(`run lock: ${describeLock(deps.lockDir, deps.processes)}`);
  const planned = report.planned ?? [];
  out(planned.length ? "would change:" : "would change: nothing, no ticket of this mode is left agent-working");
  for (const line of planned) out(`- ${line}`);
  for (const line of report.otherMode ?? []) out(`left to the other way of running: ${line}`);
  for (const line of report.failed) out(`couldn't read: ${line}`);
  return report.failed.length ? 1 : 0;
}

/** The command: `factory-recover-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(argv: string[]): number {
  let values: { "dry-run"?: boolean; mode?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { "dry-run": { type: "boolean" }, mode: { type: "string" } },
      strict: true,
    }));
  } catch (error) {
    console.error(`factory:recover: ${(error as Error).message}`);
    return 2;
  }
  const mode = values.mode ?? "local";
  if (!values["dry-run"] || (mode !== "local" && mode !== "ci")) {
    console.error("usage: npm run factory:recover -- --dry-run [--mode local|ci]");
    return 2;
  }
  const factory = loadFactory();
  return dryRun(mode, {
    repos: Object.values(factory.repos),
    reads: githubRecoveryReads,
    lockDir: runsDir(),
    now: () => new Date(),
    print: (line) => console.log(line),
  });
}

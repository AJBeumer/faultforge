/**
 * Scores saved Qodo reviews of replay PRs against an answer key, and applies a pre-registered rule that says
 * whether a candidate review setup is kept, undone, or the result is inconclusive.
 *
 *   npm run reviewer:score -- --key <key.jsonl> --runs <dir> --replays 411=391,412=312 [--confirm <file>] [--list]
 *
 * `--key`: JSON Lines, one known defect per line: `{ "id", "pr", "kind": "late" | "first", "file", "lines": [a, b] }`,
 * with the lines as they stand in the replayed commit. `--runs`: `<dir>/<arm>/<run>/pr<NNN>.qodo-api.raw.json`, one
 * saved review per replay PR, either Qodo's JSON answer or the event stream `review:wait` saves. The arms are `A`
 * (the current setup) and `B` (the candidate). `--replays`: which replay PR holds which key PR's code.
 * A finding is a candidate for a key entry when it names the same file and its lines overlap the entry's, the match
 * rule's file and line criteria (`match-rule.ts`). Whether it describes the right kind of problem is a person's
 * call: `--list` prints every candidate, and `--confirm` reads the answers, one JSON object per line:
 * `{ "entry", "arm", "run", "finding", "kind": "yes" | "no" }`. A candidate with no answer stops the score.
 *
 * Exit codes: 0 keep the candidate setup, or, with `--list`, the candidates were printed; 1 undo it; 3 inconclusive;
 * 2 it could not run: bad arguments, a key or review that can't be read, a run with no saved review for a replay
 * PR, or a candidate with no confirmation (`npm run reviewer:score` runs `reviewer-score-cli.ts`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalisePath, overlaps } from "../match/match-rule.ts";
import { parseJsonLines } from "../shared/jsonl.ts";

export interface KeyEntry {
  id: string;
  pr: number;
  kind: "late" | "first";
  file: string;
  lines: [number, number];
}

export interface RunFinding {
  id: string;
  file: string | null;
  lines: [number, number] | null;
  title: string | null;
}

/** One saved review: arm, run and replay PR. */
export interface SavedRun {
  arm: string;
  run: string;
  replayPr: number;
  findings: RunFinding[];
}

export interface Confirmation {
  entry: string;
  arm: string;
  run: string;
  finding: string;
  kind: "yes" | "no";
}

export interface Candidate {
  entry: KeyEntry;
  arm: string;
  run: string;
  finding: RunFinding;
}

export interface RunScore {
  arm: string;
  run: string;
  late: number;
  first: number;
  unmatched: number;
}

export type Decision = "keep" | "undo" | "inconclusive";

/** Every finding of every run that names an entry's file with overlapping lines, in the entry's replay PR. */
export function candidates(key: KeyEntry[], runs: SavedRun[], replays: Map<number, number>): Candidate[] {
  const out: Candidate[] = [];
  for (const run of runs) {
    const keyPr = replays.get(run.replayPr);
    for (const entry of key.filter((e) => e.pr === keyPr)) {
      for (const finding of run.findings) {
        if (finding.file === null || finding.lines === null) continue;
        if (normalisePath(finding.file) !== normalisePath(entry.file)) continue;
        if (!overlaps(finding.lines, entry.lines)) continue;
        out.push({ entry, arm: run.arm, run: run.run, finding });
      }
    }
  }
  return out;
}

const confirmKey = (entry: string, arm: string, run: string, finding: string) => `${entry}|${arm}|${run}|${finding}`;

/** Per run: the late and first-review entries caught, and the findings that caught no entry. Throws on an unanswered candidate. */
export function scoreRuns(
  key: KeyEntry[],
  runs: SavedRun[],
  found: Candidate[],
  confirmations: Confirmation[],
): RunScore[] {
  const answers = new Map(confirmations.map((c) => [confirmKey(c.entry, c.arm, c.run, c.finding), c.kind]));
  const missing = found.filter((c) => !answers.has(confirmKey(c.entry.id, c.arm, c.run, c.finding.id)));
  if (missing.length) {
    const first = missing[0] as Candidate;
    throw new Error(
      `${missing.length} candidate(s) have no confirmation, the first: entry ${first.entry.id}, arm ${first.arm}, run ${first.run}, finding ${first.finding.id}`,
    );
  }
  const yes = found.filter((c) => answers.get(confirmKey(c.entry.id, c.arm, c.run, c.finding.id)) === "yes");
  const slots = [...new Set(runs.map((r) => `${r.arm}|${r.run}`))].sort();
  return slots.map((slot) => {
    const [arm = "", run = ""] = slot.split("|");
    const mine = yes.filter((c) => c.arm === arm && c.run === run);
    const caught = new Set(mine.map((c) => c.entry.id));
    const catching = new Set(mine.map((c) => `${c.finding.id}`));
    const findings = runs.filter((r) => r.arm === arm && r.run === run).flatMap((r) => r.findings);
    return {
      arm,
      run,
      late: key.filter((e) => e.kind === "late" && caught.has(e.id)).length,
      first: key.filter((e) => e.kind === "first" && caught.has(e.id)).length,
      unmatched: findings.filter((f) => !catching.has(f.id)).length,
    };
  });
}

/** The pre-registered rule, on arm A (current) and arm B (candidate). */
export function decide(scores: RunScore[]): Decision {
  const of = (arm: string) => scores.filter((s) => s.arm === arm);
  const a = of("A");
  const b = of("B");
  if (!a.length || !b.length) throw new Error("both arms A and B need at least one scored run");
  const lo = (s: RunScore[], k: "late" | "first") => Math.min(...s.map((x) => x[k]));
  const hi = (s: RunScore[], k: "late" | "first") => Math.max(...s.map((x) => x[k]));
  if (hi(b, "late") < lo(a, "late") || hi(b, "first") < lo(a, "first")) return "undo";
  if (lo(b, "late") > hi(a, "late") && lo(b, "first") >= lo(a, "first")) return "keep";
  return "inconclusive";
}

/** Qodo's answer, from its JSON or from the event stream `review:wait` saves. */
export function parseReview(text: string): { findings?: unknown } {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  if (!data) throw new Error("neither JSON nor an event stream with a data line");
  const inner = JSON.parse(data.slice(6))?.result?.content?.[0]?.text;
  if (typeof inner !== "string") throw new Error("the event stream holds no review text");
  return JSON.parse(inner);
}

function toFinding(raw: unknown, where: string): RunFinding {
  const f = raw as Record<string, unknown>;
  if (typeof f?.id !== "string") throw new Error(`${where}: a finding has no id`);
  const start = f.start_line;
  const end = f.end_line ?? start;
  const lines = Number.isInteger(start) && Number.isInteger(end) ? ([start, end] as [number, number]) : null;
  return {
    id: f.id,
    file: typeof f.file_path === "string" ? f.file_path : null,
    lines,
    title: typeof f.title === "string" ? f.title : null,
  };
}

export function readRuns(dir: string, replays: Map<number, number>): SavedRun[] {
  const runs: SavedRun[] = [];
  for (const arm of readdirSync(dir).sort()) {
    for (const run of readdirSync(join(dir, arm)).sort()) {
      for (const replayPr of replays.keys()) {
        const file = join(dir, arm, run, `pr${replayPr}.qodo-api.raw.json`);
        if (!existsSync(file)) throw new Error(`no saved review for replay PR ${replayPr} in arm ${arm}, run ${run}`);
        const review = parseReview(readFileSync(file, "utf8"));
        if (!Array.isArray(review.findings)) throw new Error(`${file}: the review holds no findings list`);
        runs.push({ arm, run, replayPr, findings: review.findings.map((f) => toFinding(f, file)) });
      }
    }
  }
  return runs;
}

export function readKey(path: string): KeyEntry[] {
  const entries = parseJsonLines<KeyEntry>(readFileSync(path, "utf8"));
  for (const [i, e] of entries.entries()) {
    const ok =
      typeof e?.id === "string" &&
      Number.isInteger(e.pr) &&
      (e.kind === "late" || e.kind === "first") &&
      typeof e.file === "string" &&
      Array.isArray(e.lines);
    if (!ok) throw new Error(`${path}: entry ${i + 1} needs id, pr, kind (late or first), file and lines`);
  }
  return entries;
}

export function parseReplays(text: string | undefined): Map<number, number> {
  const map = new Map<number, number>();
  for (const pair of (text ?? "").split(",").filter(Boolean)) {
    const [replay, original] = pair.split("=").map(Number);
    if (!Number.isInteger(replay) || !Number.isInteger(original))
      throw new Error(`--replays: "${pair}" is not <replay>=<pr>`);
    map.set(replay as number, original as number);
  }
  if (!map.size) throw new Error("--replays: give at least one <replay>=<pr> pair");
  return map;
}

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const EXIT: Record<Decision, number> = { keep: 0, undo: 1, inconclusive: 3 };

export function main(argv: string[], log: (line: string) => void = console.log): number {
  try {
    const keyPath = option(argv, "--key");
    const runsDir = option(argv, "--runs");
    if (!keyPath || !runsDir) throw new Error("usage: --key <key.jsonl> --runs <dir> --replays <replay>=<pr>,...");
    const replays = parseReplays(option(argv, "--replays"));
    const key = readKey(keyPath);
    const runs = readRuns(runsDir, replays);
    const found = candidates(key, runs, replays);
    if (argv.includes("--list")) {
      for (const c of found) {
        log(
          JSON.stringify({
            entry: c.entry.id,
            arm: c.arm,
            run: c.run,
            finding: c.finding.id,
            file: c.finding.file,
            lines: c.finding.lines,
            title: c.finding.title,
          }),
        );
      }
      log(`reviewer:score: ${found.length} candidate(s) to confirm`);
      return 0;
    }
    const confirmPath = option(argv, "--confirm");
    const confirmations = confirmPath ? parseJsonLines<Confirmation>(readFileSync(confirmPath, "utf8")) : [];
    const scores = scoreRuns(key, runs, found, confirmations);
    const late = key.filter((e) => e.kind === "late").length;
    const first = key.length - late;
    for (const s of scores)
      log(
        `arm ${s.arm} run ${s.run}: late ${s.late}/${late}, first review ${s.first}/${first}, unmatched findings ${s.unmatched}`,
      );
    const decision = decide(scores);
    log(`decision: ${decision}`);
    return EXIT[decision];
  } catch (error) {
    log(`reviewer:score could not run: ${(error as Error).message}`);
    return 2;
  }
}

/**
 * Replays the rule behind Qodo's "approved" label on saved reviews whose answer is known: would the label have
 * approved code that was wrong, or held code that was fine? The workflow is never set up on the target; this
 * is computed from the saved reviews, with the same rule `approval:check` uses (`approval-rule.ts`).
 *
 *   npm run approval:replay
 *   npm run approval:replay -- --key <held-out key.jsonl> --runs <dir> [--replays 411=391,...]
 *
 * Always: the adjudicated cases the public decision log names (as `gate:replay -- --public` loads them). A bug
 * run the label would approve is a false approval; a control it would hold is a false hold.
 * With `--key` and `--runs`: a review test's saved runs (`<dir>/<arm>/<run>/pr<NNN>.qodo-api.raw.json`), whose
 * every PR holds the key's proven defects. Without `--replays`, `<NNN>` is the key's PR (the `scored/` layout);
 * with it, `<NNN>` is the replay PR, mapped to the key's PR as `reviewer:score` maps it. Every key line needs
 * `first` and `parentOfFirst`: each PR's changed files come from `git diff` between them, so the guards in
 * `factory.json` apply too. A run whose review never finished (`review_complete` not true) is listed, not counted.
 *
 * It reads only. Exit codes: 0 the report was printed; 2 it could not run (bad arguments, private storage, a
 * key line without its commits, a run unreadable, git failing), or an unexpected error stopped it, even while loading
 * (`npm run approval:replay` runs `approval-replay-cli.ts`).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blockingLevels, guardedFiles } from "../review/approval-rule.ts";
import { parseReplays, readRuns, type SavedRun } from "../review/reviewer-score.ts";
import { gateOf, loadFactory } from "../shared/factory-config.ts";
import { parseJsonLines } from "../shared/jsonl.ts";
import { privateDir, ROOT } from "../shared/paths.ts";
import { loadCases, publicCaseIds, type ReplayCase } from "./gate-replay.ts";

export type LabelOutcome =
  | "false approval"
  | "false hold"
  | "held, correctly"
  | "approved, correctly"
  | "held by a guard only";

/** Pure: one adjudicated case. A bug run should never get the label; a control should. */
export function caseOutcome(c: Pick<ReplayCase, "kind" | "findings">, flag: string[]): LabelOutcome {
  const labelled =
    blockingLevels(
      c.findings.map((f) => f.severity),
      flag,
    ).length === 0;
  if (c.kind === "control") return labelled ? "approved, correctly" : "false hold";
  return labelled ? "false approval" : "held, correctly";
}

/** Pure: one review of code that holds proven defects. */
export function defectOutcome(levels: (string | undefined)[], flag: string[], guarded: string[]): LabelOutcome {
  if (blockingLevels(levels, flag).length) return "held, correctly";
  return guarded.length ? "held by a guard only" : "false approval";
}

export function totals(outcomes: LabelOutcome[]): string {
  const count = (o: LabelOutcome) => outcomes.filter((x) => x === o).length;
  return (["false approval", "held by a guard only", "held, correctly", "approved, correctly", "false hold"] as const)
    .map((o) => `${o}: ${count(o)}`)
    .join("; ");
}

/** Qodo's labels from most to least severe; the highest one a review raised is printed with each line. */
const RANK = ["action_required", "remediation_recommended", "informational"];

export function highestLevel(levels: (string | null | undefined)[]): string {
  const known = RANK.find((r) => levels.includes(r));
  const other = levels.find((l) => typeof l === "string" && !RANK.includes(l));
  // A label the gate doesn't know is shown first: it blocks, and nobody guessed its rank.
  return other ?? known ?? (levels.length ? "none" : "no findings");
}

export interface KeyLine {
  pr: number;
  first: string;
  parentOfFirst: string;
}

/** The key lines, each with the reviewed commit and its parent, which the replay diffs for guarded paths. */
export function checkKey(lines: unknown[]): KeyLine[] {
  const sha = (v: unknown) => typeof v === "string" && /^[0-9a-f]{40}$/i.test(v);
  return lines.map((raw, i) => {
    const line = raw as Partial<KeyLine>;
    if (!Number.isInteger(line?.pr) || !sha(line.first) || !sha(line.parentOfFirst)) {
      throw new Error(
        `key line ${i + 1} needs pr, first and parentOfFirst (the reviewed commit and its parent, as 40-character ids): the replay diffs them to find guarded paths`,
      );
    }
    return line as KeyLine;
  });
}

/**
 * Pure: the label replayed on each saved run. `replays` maps a run's file number to the key's PR (the identity
 * when runs are stored under the key's PR numbers). A run whose session says `completed` while
 * `review_complete` stays false is not counted: by this project's rule that review never finished.
 */
export function replayRuns(
  key: KeyLine[],
  runs: SavedRun[],
  replays: Map<number, number>,
  changed: (from: string, to: string) => string[],
  guards: string[],
  flag: string[],
): string[] {
  const out: string[] = [];
  const byArm = new Map<string, LabelOutcome[]>();
  for (const r of runs) {
    const pr = replays.get(r.replayPr) as number;
    const where = `arm ${r.arm} run ${r.run} PR ${r.replayPr}${pr !== r.replayPr ? ` (replays ${pr})` : ""}`;
    const entries = key.filter((k) => k.pr === pr);
    const entry = entries[0] as KeyLine;
    const guarded = guardedFiles(changed(entry.parentOfFirst, entry.first), guards);
    const levels = r.findings.map((f) => f.level);
    const o = defectOutcome(levels, flag, guarded);
    const finished = r.reviewComplete === true;
    if (finished) byArm.set(r.arm, [...(byArm.get(r.arm) ?? []), o]);
    out.push(
      `  ${where}: ${entries.length} proven defect(s), ${r.findings.length} finding(s), highest ${highestLevel(levels)}${guarded.length ? ", guarded" : ""}  ->  ${o}${finished ? "" : ", not counted: its review never finished (review_complete is not true)"}`,
    );
  }
  for (const [arm, outcomes] of [...byArm].sort()) out.push(`  arm ${arm}: ${totals(outcomes)}`);
  return out;
}

/** Every replay is of a key PR, and every key PR has one: a PR left out would drop its defects without a word. */
export function checkReplays(prs: number[], replays: Map<number, number>): void {
  const replayed = [...replays.values()];
  const missing = replayed.filter((pr) => !prs.includes(pr));
  if (missing.length) throw new Error(`--replays names PRs the key doesn't hold: ${missing.join(", ")}`);
  const unreplayed = prs.filter((pr) => !replayed.includes(pr));
  if (unreplayed.length) throw new Error(`--replays gives no replay for the key's PRs: ${unreplayed.join(", ")}`);
}

const gitChanged = (from: string, to: string): string[] =>
  execFileSync("git", ["-C", ROOT, "diff", "--name-only", from, to], { encoding: "utf8" }).split("\n").filter(Boolean);

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, changed = gitChanged): number {
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const [keyPath, runsDir, replaysText] = [opt("--key"), opt("--runs"), opt("--replays")];
  const expected = 4 + (replaysText === undefined ? 0 : 2);
  if (argv.length !== 0 && !(argv.length === expected && keyPath && runsDir)) {
    console.error("usage: npm run approval:replay [-- --key <key.jsonl> --runs <dir> [--replays 411=391,...]]");
    return 2;
  }
  const factory = loadFactory();
  const { flag } = gateOf(factory);
  const guards = factory.repos.faultforge?.approval?.guards ?? [];
  const out: string[] = [
    `The label's rule: every open finding labelled ${flag.join(" or ") || "nothing"} (only flagged by the gate), and no guarded path (${guards.join(", ") || "none"}).`,
    "",
  ];
  try {
    const dir = join(ROOT, "docs", "decisions");
    const only = publicCaseIds(
      readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => readFileSync(join(dir, f), "utf8")),
    );
    const { cases, skipped } = loadCases(privateDir(env), only, env);
    out.push("Adjudicated cases the public decision log names (target reviews; no guard applies there):");
    const byConfig = new Map<string, LabelOutcome[]>();
    for (const c of cases) {
      const o = caseOutcome(c, flag);
      const config = c.config ?? "not recorded";
      byConfig.set(config, [...(byConfig.get(config) ?? []), o]);
      const kind = c.kind === "control" ? "control" : "planted bug";
      const highest = highestLevel(c.findings.map((f) => f.severity));
      out.push(`  ${c.caseId}  [${config}]  ${kind}, highest ${highest}  ->  ${o}`);
    }
    for (const [config, outcomes] of [...byConfig].sort()) out.push(`  configuration ${config}: ${totals(outcomes)}`);
    out.push(`  all cases: ${totals([...byConfig.values()].flat())}`);
    for (const line of skipped) out.push(`  not counted: ${line}`);
    if (keyPath && runsDir) {
      const key = checkKey(parseJsonLines(readFileSync(keyPath, "utf8")));
      const prs = [...new Set(key.map((k) => k.pr))].sort((a, b) => a - b);
      const replays = replaysText === undefined ? new Map(prs.map((pr) => [pr, pr])) : parseReplays(replaysText);
      checkReplays(prs, replays);
      out.push("", "Scored review runs, every PR holding proven defects:");
      out.push(...replayRuns(key, readRuns(runsDir, replays), replays, changed, guards, flag));
    }
  } catch (e) {
    console.error(`approval:replay: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  out.push("", "These are runs, not distinct bugs: a rerun of the same change counts twice.");
  for (const line of out) console.log(line);
  return 0;
}

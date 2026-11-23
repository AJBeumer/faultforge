/**
 * Replays the rule behind Qodo's "approved" label on saved reviews whose answer is known: would the label have
 * approved code that was wrong, or held code that was fine? The workflow is never set up on the target; this
 * is computed from the saved reviews, with the same rule `approval:check` uses (`approval-rule.ts`).
 *
 *   npm run approval:replay
 *   npm run approval:replay -- --key <held-out key.jsonl> --runs <dir>
 *
 * Always: the adjudicated cases the public decision log names (as `gate:replay -- --public` loads them). A bug
 * run the label would approve is a false approval; a control it would hold is a false hold.
 * With `--key` and `--runs`: a review test's scored runs (`<dir>/<arm>/<run>/pr<NNN>.qodo-api.raw.json`, as
 * `reviewer:score` reads them), whose every PR holds the key's proven defects. Each PR's changed files come
 * from `git diff` between the key's `parentOfFirst` and `first`, so the guards in `factory.json` apply too.
 *
 * It reads only. Exit codes: 0 the report was printed; 2 it could not run (bad arguments, private storage, a
 * key or a run unreadable, git failing), or an unexpected error stopped it, even while loading
 * (`npm run approval:replay` runs `approval-replay-cli.ts`).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { blockingLevels, guardedFiles } from "../review/approval-rule.ts";
import { readRuns } from "../review/reviewer-score.ts";
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

interface KeyLine {
  pr: number;
  first: string;
  parentOfFirst: string;
}

const gitChanged = (from: string, to: string): string[] =>
  execFileSync("git", ["-C", ROOT, "diff", "--name-only", from, to], { encoding: "utf8" }).split("\n").filter(Boolean);

export function main(argv: string[], env: NodeJS.ProcessEnv = process.env, changed = gitChanged): number {
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const [keyPath, runsDir] = [opt("--key"), opt("--runs")];
  if (argv.length !== 0 && !(argv.length === 4 && keyPath && runsDir)) {
    console.error("usage: npm run approval:replay [-- --key <key.jsonl> --runs <dir>]");
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
      out.push(`  ${c.caseId}  [${config}]  ${c.kind === "control" ? "control" : "planted bug"}  ->  ${o}`);
    }
    for (const [config, outcomes] of [...byConfig].sort()) out.push(`  configuration ${config}: ${totals(outcomes)}`);
    out.push(`  all cases: ${totals([...byConfig.values()].flat())}`);
    for (const line of skipped) out.push(`  not counted: ${line}`);
    if (keyPath && runsDir) {
      const key = parseJsonLines<KeyLine>(readFileSync(keyPath, "utf8"));
      const prs = [...new Set(key.map((k) => k.pr))].sort((a, b) => a - b);
      const runs = readRuns(runsDir, new Map(prs.map((pr) => [pr, pr])));
      out.push("", "Scored review runs, every PR holding proven defects:");
      const byArm = new Map<string, LabelOutcome[]>();
      for (const r of runs) {
        const entry = key.find((k) => k.pr === r.replayPr) as KeyLine;
        const guarded = guardedFiles(changed(entry.parentOfFirst, entry.first), guards);
        const o = defectOutcome(
          r.findings.map((f) => f.level),
          flag,
          guarded,
        );
        byArm.set(r.arm, [...(byArm.get(r.arm) ?? []), o]);
        const defects = key.filter((k) => k.pr === r.replayPr).length;
        out.push(
          `  arm ${r.arm} run ${r.run} PR ${r.replayPr}: ${defects} proven defect(s), ${r.findings.length} finding(s)${guarded.length ? ", guarded" : ""}  ->  ${o}`,
        );
      }
      for (const [arm, outcomes] of [...byArm].sort()) out.push(`  arm ${arm}: ${totals(outcomes)}`);
    }
  } catch (e) {
    console.error(`approval:replay: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  out.push("", "These are runs, not distinct bugs: a rerun of the same change counts twice.");
  for (const line of out) console.log(line);
  return 0;
}

/**
 * Replays the quality gate over the saved reviews of adjudicated cases: what would each candidate threshold
 * have decided about the findings the reviewer raised on a pull request with a known planted bug, or on a
 * clean control?
 *
 *   npm run gate:replay              every adjudicated case in private storage (for the owner)
 *   npm run gate:replay -- --public  only cases the public decision log already names
 *
 * For a bug case the reviewer caught, the question is whether the gate would have required a fix of a
 * finding that describes the bug, or let the pull request through with it. The catching findings are found
 * with the fixed match rule, unchanged, from the answer key's injection and the template's kind terms.
 * For every case it also counts the other findings the gate would have forced the agent to act on.
 *
 * Two thresholds are compared with the same gate function the runner uses: the gate saved in
 * `factory.json`, and that gate with only its first label to fix (the others only flagged).
 *
 * It reads only: case records, the answer key, the audit log, templates and the public decision log.
 * A case with an incomplete review or no verdict is listed and counted in nothing.
 *
 * Exit codes: 0 the report was printed; 2 it could not run (private storage or a case's data unreadable),
 * or an unexpected error stopped it, even while loading (`npm run gate:replay` runs `gate-replay-cli.ts`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type LedgerEntry, readAuditLog, readLedger } from "../ledger/ledger.ts";
import { applyMatchRule, isRange, type MatchFinding } from "../match/match-rule.ts";
import { gateOf, loadFactory, type QualityGate } from "../shared/factory-config.ts";
import { CASE_ID, privateDir, ROOT } from "../shared/paths.ts";
import { gateAccount, labelName } from "../shared/quality-gate.ts";
import { kindTermsOf, templateDir } from "../shared/templates.ts";
import { latestEvent } from "./case-builder.ts";

/** One case as the replay needs it. */
export interface ReplayCase {
  caseId: string;
  /** "sabotage" for a planted bug, "control" for a clean change. */
  kind: string;
  /** The Qodo configuration version the case was reviewed under, as its record names it; null when it names none. */
  config: string | null;
  /** Null for a control: nothing was planted. */
  injection: { file: string; lines: [number, number] } | null;
  kindTerms: string[];
  /** The review's findings, with Qodo's label in `severity`. */
  findings: (MatchFinding & { severity?: string | null })[];
}

export interface GateOutcome {
  /** A finding that describes the planted bug is one the gate says to fix, or blocks as unknown. */
  bugBlocked: boolean;
  /** Findings the gate would make the agent act on that do not describe the planted bug. */
  otherBlocking: number;
  /** Findings the gate only reports. */
  flagged: number;
  /** Findings with a label the gate doesn't know. */
  unknown: number;
}

export interface ReplayLine {
  caseId: string;
  kind: string;
  config: string | null;
  caught: boolean;
  /** Labels of the findings that describe the planted bug, as recorded; "none" for a finding without one. */
  catchLabels: string[];
  findings: number;
  outcomes: Record<string, GateOutcome>;
}

/** The gate with only its first label to fix; the rest are only flagged. */
export function firstLabelOnly(gate: QualityGate): QualityGate {
  return { ...gate, fix: gate.fix.slice(0, 1), flag: [...gate.fix.slice(1), ...gate.flag] };
}

/** Pure: one case under each named gate. */
export function replayCase(input: ReplayCase, gates: Record<string, QualityGate>): ReplayLine {
  const matched = input.injection
    ? new Set(applyMatchRule(input.injection, input.findings, input.kindTerms).matchedFindingIds)
    : new Set<string>();
  const catching = input.findings.filter((f) => matched.has(f.id));
  const others = input.findings.filter((f) => !matched.has(f.id));
  const outcomes: Record<string, GateOutcome> = {};
  for (const [name, gate] of Object.entries(gates)) {
    const onCatch = gateAccount({ openFindings: catching }, gate);
    const onOthers = gateAccount({ openFindings: others }, gate);
    const all = gateAccount({ openFindings: input.findings }, gate);
    outcomes[name] = {
      bugBlocked: catching.length > 0 && !onCatch.met,
      otherBlocking: onOthers.mustFix.length + onOthers.unknown.length,
      flagged: all.flagged.length,
      unknown: all.unknown.length,
    };
  }
  return {
    caseId: input.caseId,
    kind: input.kind,
    config: input.config,
    caught: catching.length > 0,
    catchLabels: catching.map((f) => (typeof f.severity === "string" ? f.severity : "none")),
    findings: input.findings.length,
    outcomes,
  };
}

export interface ReplaySummary {
  bugRuns: number;
  caught: number;
  /** Caught, and the gate would have required the fix. */
  caughtAndBlocked: number;
  /** Caught by the reviewer, and the gate would still have called the pull request done. */
  caughtButPassed: number;
  controls: number;
  /** Findings on controls the gate would have made the agent act on. */
  forcedOnControls: number;
  /** Findings on bug runs, other than the catch, the gate would have made the agent act on. */
  forcedOnBugRuns: number;
  flagged: number;
  unknown: number;
}

/** Pure: the totals for one gate over the replayed lines. */
export function summarise(lines: ReplayLine[], gate: string): ReplaySummary {
  const bugs = lines.filter((l) => l.kind !== "control");
  const controls = lines.filter((l) => l.kind === "control");
  const of = (l: ReplayLine) => l.outcomes[gate] as GateOutcome;
  const sum = (ls: ReplayLine[], pick: (o: GateOutcome) => number) => ls.reduce((n, l) => n + pick(of(l)), 0);
  const caught = bugs.filter((l) => l.caught);
  return {
    bugRuns: bugs.length,
    caught: caught.length,
    caughtAndBlocked: caught.filter((l) => of(l).bugBlocked).length,
    caughtButPassed: caught.filter((l) => !of(l).bugBlocked).length,
    controls: controls.length,
    forcedOnControls: sum(controls, (o) => o.otherBlocking),
    forcedOnBugRuns: sum(bugs, (o) => o.otherBlocking),
    flagged: sum(lines, (o) => o.flagged),
    unknown: sum(lines, (o) => o.unknown),
  };
}

/** A line's configuration for the report: the version its record names, in plain characters, or "not recorded". */
function configName(line: ReplayLine): string {
  return typeof line.config === "string" && line.config
    ? line.config.replace(/[^\w. -]/g, "?").slice(0, 40)
    : "not recorded";
}

/** The report's lines: one per case, then for each configuration one block per gate. */
export function replayReport(lines: ReplayLine[], gates: Record<string, QualityGate>, skipped: string[]): string[] {
  const names = Object.keys(gates);
  const out: string[] = [];
  for (const [name, gate] of Object.entries(gates)) {
    out.push(
      `Gate "${name}": fix ${gate.fix.map(labelName).join(", ")}; flag ${gate.flag.map(labelName).join(", ") || "nothing"}`,
    );
  }
  out.push("");
  for (const line of lines) {
    const catchText =
      line.kind === "control"
        ? "control"
        : line.caught
          ? `caught, labelled ${[...new Set(line.catchLabels)].map(labelName).join(" and ")}`
          : "missed by the reviewer";
    const per = names
      .map((name) => {
        const o = line.outcomes[name] as GateOutcome;
        const verdict =
          line.kind === "control" || !line.caught ? "" : o.bugBlocked ? "fix required" : "PASSES WITH THE BUG";
        const extra = `${o.otherBlocking} other to act on${o.unknown ? `, ${o.unknown} unknown label` : ""}`;
        return `${name}: ${[verdict, extra].filter(Boolean).join(", ")}`;
      })
      .join(" | ");
    out.push(`${line.caseId}  [${configName(line)}]  ${catchText}; ${line.findings} finding(s)  ->  ${per}`);
  }
  // Results are only comparable under the same configuration: one block per configuration, then all together.
  const configs = [...new Set(lines.map(configName))].sort();
  const groups: [string, ReplayLine[]][] = [
    ...configs.map((c): [string, ReplayLine[]] => [`configuration ${c}`, lines.filter((l) => configName(l) === c)]),
    ...(configs.length > 1 ? [["every configuration together", lines] as [string, ReplayLine[]]] : []),
  ];
  for (const [title, group] of groups) {
    out.push("");
    out.push(`${title}:`);
    for (const name of names) {
      const s = summarise(group, name);
      out.push(`  Under "${name}":`);
      out.push(`    bug runs: ${s.bugRuns}; the reviewer caught ${s.caught}`);
      out.push(
        `    of those caught: fix required in ${s.caughtAndBlocked}; passes with the bug in ${s.caughtButPassed}`,
      );
      out.push(
        `    other findings to act on: ${s.forcedOnBugRuns} on bug runs, ${s.forcedOnControls} on ${s.controls} control(s)`,
      );
      out.push(`    only flagged: ${s.flagged}; unknown label: ${s.unknown}`);
    }
  }
  if (skipped.length) {
    out.push("");
    out.push("Not counted:");
    for (const line of skipped) out.push(`  ${line}`);
  }
  out.push("");
  out.push("These are runs, not distinct bugs: a rerun of the same change counts twice.");
  return out;
}

/** Case ids the public decision log names: `FF-NNNN`, and both ends and the middle of `FF-NNNN to FF-NNNN`. */
export function publicCaseIds(texts: string[]): Set<string> {
  const ids = new Set<string>();
  const id = (n: number) => `FF-${String(n).padStart(4, "0")}`;
  for (const text of texts) {
    for (const m of text.matchAll(/\bFF-(\d{4})\b(?:\s+to\s+FF-(\d{4})\b)?/g)) {
      const from = Number(m[1]);
      const to = m[2] === undefined ? from : Number(m[2]);
      // A range written backwards, or absurdly long, names only its two ends.
      if (to >= from && to - from <= 100) for (let n = from; n <= to; n++) ids.add(id(n));
      else {
        ids.add(id(from));
        ids.add(id(to));
      }
    }
  }
  return ids;
}

export interface LoadResult {
  cases: ReplayCase[];
  skipped: string[];
}

/** Reads every case the replay may count from private storage. Throws when the storage itself can't be read. */
export function loadCases(priv: string, only: Set<string> | null, env: NodeJS.ProcessEnv = process.env): LoadResult {
  const casesDir = join(priv, "cases");
  const truth = readLedger(join(priv, "ground-truth.jsonl")) as Record<string, unknown>[];
  // Each case's latest verdict, picked the way `case:build` picks it (`latestEvent`: by time, not by place in
  // the file), so a record it just built is never taken for a stale one. A verdict with no readable time
  // stops the replay: totals that silently lack a case would be worse than none.
  const verdicts = new Map<string, LedgerEntry[]>();
  for (const e of readAuditLog(join(priv, "audit-events.jsonl"))) {
    if (e.type !== "case.adjudicated" || typeof e.caseId !== "string") continue;
    verdicts.set(e.caseId, [...(verdicts.get(e.caseId) ?? []), e]);
  }
  const latestVerdict = new Map<string, unknown>();
  for (const [caseId, events] of verdicts) {
    // Under a public list, a case outside it is not looked at, so nothing about it can be printed, not even
    // in an error.
    if (only && !only.has(caseId)) continue;
    for (const e of events) {
      if (typeof e.at !== "string" || Number.isNaN(Date.parse(e.at))) {
        throw new Error(`${caseId}: a verdict in the audit log has no readable time`);
      }
    }
    latestVerdict.set(caseId, latestEvent(events, ["case.adjudicated"], "the adjudication stage").at);
  }
  const cases: ReplayCase[] = [];
  const skipped: string[] = [];
  const files = readdirSync(casesDir)
    .filter((f) => CASE_ID.test(f.replace(/\.json$/, "")) && f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const caseId = file.replace(/\.json$/, "");
    // A case the public record doesn't hold is left out without a word: not listed, not counted.
    if (only && !only.has(caseId)) continue;
    const record = JSON.parse(readFileSync(join(casesDir, file), "utf8")) as {
      kind?: string;
      status?: string;
      findings?: unknown;
      review?: { configVersion?: unknown } | null;
      human?: { adjudicatedAt?: unknown } | null;
    };
    const config = typeof record.review?.configVersion === "string" ? record.review.configVersion : null;
    if (!latestVerdict.has(caseId)) {
      skipped.push(`${caseId}: no verdict yet`);
      continue;
    }
    // A record built from an earlier verdict holds that verdict's findings and status, not the case's own now.
    const verdictAt = latestVerdict.get(caseId);
    if (typeof verdictAt !== "string" || record.human?.adjudicatedAt !== verdictAt) {
      skipped.push(`${caseId}: its saved record doesn't hold its latest verdict; build it again with case:build`);
      continue;
    }
    if (record.status !== "complete") {
      skipped.push(`${caseId}: its review is ${record.status ?? "not recorded as complete"}`);
      continue;
    }
    if (!Array.isArray(record.findings)) throw new Error(`${caseId}: the case record has no list of findings`);
    const entry = truth.find((e) => e.caseId === caseId);
    if (!entry) throw new Error(`${caseId}: the answer key holds no entry for it`);
    const kind = String(entry.kind ?? record.kind ?? "");
    const findings = record.findings as ReplayCase["findings"];
    if (kind === "control") {
      cases.push({ caseId, kind, config, injection: null, kindTerms: [], findings });
      continue;
    }
    const templateId = String(entry.templateId ?? "");
    const dir = templateDir(templateId, env);
    if (!dir) throw new Error(`${caseId}: its template isn't in private storage or templates/seed`);
    const kindTerms = kindTermsOf(JSON.parse(readFileSync(join(dir, "template.json"), "utf8")), "the case's template");
    if (typeof entry.injectedFile !== "string" || !isRange(entry.injectedLines)) {
      throw new Error(`${caseId}: the answer key gives no injected file and line range`);
    }
    cases.push({
      caseId,
      kind,
      config,
      injection: { file: entry.injectedFile, lines: entry.injectedLines },
      kindTerms,
      findings,
    });
  }
  // A case with a verdict and no saved record is said, never dropped in silence. Under a public list, only
  // the cases on it are spoken of.
  const withRecord = new Set(files.map((f) => f.replace(/\.json$/, "")));
  for (const caseId of [...latestVerdict.keys()].sort()) {
    if (withRecord.has(caseId) || (only && !only.has(caseId))) continue;
    skipped.push(`${caseId}: it has a verdict but no saved record; build one with case:build`);
  }
  skipped.sort();
  return { cases, skipped };
}

/** The command: `gate-replay-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--public")) {
    console.error("usage: npm run gate:replay [-- --public]");
    return 2;
  }
  const priv = privateDir(env);
  if (!existsSync(join(priv, "ground-truth.jsonl")) || !existsSync(join(priv, "cases"))) {
    console.error(`gate:replay: no answer key and case records under ${priv}`);
    return 2;
  }
  let only: Set<string> | null = null;
  if (argv[0] === "--public") {
    const dir = join(ROOT, "docs", "decisions");
    only = publicCaseIds(
      readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => readFileSync(join(dir, f), "utf8")),
    );
  }
  const saved = gateOf(loadFactory());
  const gates: Record<string, QualityGate> = { "first label only": firstLabelOnly(saved), "saved gate": saved };
  let loaded: LoadResult;
  try {
    loaded = loadCases(priv, only, env);
  } catch (e) {
    console.error(`gate:replay: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const lines = loaded.cases.map((c) => replayCase(c, gates));
  if (only) console.log("Only cases the public decision log names.");
  for (const line of replayReport(lines, gates, loaded.skipped)) console.log(line);
  return 0;
}

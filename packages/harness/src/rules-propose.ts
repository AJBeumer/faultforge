/**
 * Finds repeated patterns in the evidence table and proposes a rule, as a ticket for the owner.
 *
 *   npm run rules:propose                 # print the draft proposals
 *   npm run rules:propose -- --open       # open one proposal ticket per new pattern
 *
 * A pattern is at least 3 findings with the same category, in the same repo, across at least 2
 * PRs. No pattern, no proposal; a pattern that already has a proposal ticket (open or closed) is
 * not proposed twice. Opening a ticket needs a token with issue write access (`GH_TOKEN`). The
 * factory runner calls this once after each finished run, so the factory raises its own hand when
 * its work keeps producing the same finding — and the owner alone decides what becomes a rule.
 */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type FactoryConfig, loadFactory } from "./factory-config.ts";
import { gh } from "./github.ts";
import { evidenceDir, privateDir, ROOT } from "./paths.ts";
import { buildTable, casePrs, type EvidenceRow, groundTruthCommits, readSavedReviews } from "./rules-evidence.ts";

/** The pattern threshold, in one place: this many findings, over at least this many PRs. */
export const THRESHOLD = { findings: 3, prs: 2 };

export interface Pattern {
  repo: string;
  category: string;
  findings: EvidenceRow[];
  prs: number[];
}

/** Repeated patterns in the table: same repo and category, over the threshold. Deterministic. */
export function findPatterns(rows: EvidenceRow[], threshold = THRESHOLD): Pattern[] {
  const groups = new Map<string, EvidenceRow[]>();
  for (const row of rows) {
    if (!row.category) continue;
    const key = `${row.repo}\u0000${row.category}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const patterns: Pattern[] = [];
  for (const [key, findings] of groups) {
    const [repo, category] = key.split("\u0000") as [string, string];
    const prs = [...new Set(findings.map((f) => f.pr))].sort((a, b) => a - b);
    if (findings.length >= threshold.findings && prs.length >= threshold.prs) {
      patterns.push({ repo, category, findings, prs });
    }
  }
  return patterns.sort((a, b) => b.findings.length - a.findings.length || a.category.localeCompare(b.category));
}

/** The proposal ticket's title. Deterministic, so an existing ticket blocks a duplicate. */
export function proposalTitle(pattern: Pattern): string {
  return `Rule proposal: repeated ${pattern.category} findings in ${pattern.repo} reviews`;
}

/**
 * The proposal ticket's body. PRs in this repo are linked; PRs in a reviewed repo are named as
 * plain text, never linked, so the proposal can't surface on that repo's timeline.
 */
export function proposalBody(pattern: Pattern, lab: string): string {
  const prName = (row: EvidenceRow) => (row.github === lab ? `#${row.pr}` : `${row.repo} ${row.pr}`);
  // Review-written text is data: stripped of table and code markup and shown as code, so a title
  // can't change the ticket's rendering, mention anyone, or link anywhere.
  const safe = (text: string) =>
    `\`${
      text
        .replace(/[|`\\]/g, " ")
        .replace(/\s+/g, " ")
        .trim() || "(no title)"
    }\``;
  const lines = pattern.findings
    .map((f) => `| ${prName(f)} | \`${f.id}\` | ${safe(f.title ?? "(no title)")} | ${f.severity ?? "?"} |`)
    .join("\n");
  return `The factory's saved reviews repeat a pattern: **${pattern.findings.length} ${pattern.category} findings across ${pattern.prs.length} PRs** in \`${pattern.repo}\` (threshold: ${THRESHOLD.findings} findings over ${THRESHOLD.prs} PRs). Case PRs are never counted.

| PR | Finding | Title | Severity |
|---|---|---|---|
${lines}

Nothing changes until you decide. If a rule is worth it, give it its own ticket: evidence check, hold-out score, and the proposal-format PR. If not, close this with a sentence saying why, and this pattern won't be proposed again.

<!-- rule-pattern: ${pattern.repo}/${pattern.category} -->`;
}

/** The patterns that don't already have a proposal ticket, by exact title. */
export function newPatterns(patterns: Pattern[], existingTitles: string[]): Pattern[] {
  const existing = new Set(existingTitles);
  return patterns.filter((p) => !existing.has(proposalTitle(p)));
}

/** Every proposal ticket's title, open or closed, every page. */
function existingProposalTitles(lab: string): string[] {
  const pages = JSON.parse(
    gh("api", "--paginate", "--slurp", `repos/${lab}/issues?labels=rule-proposal&state=all`),
  ) as { title: string }[][];
  return pages.flat().map((issue) => issue.title);
}

export interface ProposeResult {
  patterns: Pattern[];
  proposed: Pattern[];
  opened: string[];
}

/** Builds the table, finds patterns, and (with `open`) opens a ticket per new pattern. */
export function propose(
  factory: FactoryConfig,
  root: string,
  options: { open: boolean },
  runGh: (...args: string[]) => string = gh,
  listTitles: (lab: string) => string[] = existingProposalTitles,
  print: (line: string) => void = console.log,
): ProposeResult {
  const lab = Object.values(factory.repos).find((r) => r.guard === "lab")?.github;
  if (!lab) throw new Error("no lab repo in factory.json");
  const evidence = evidenceDir(factory, root);
  const priv = privateDir(process.env, factory, root);
  const excluded = {
    prs: casePrs(join(priv, "cases")),
    commits: groundTruthCommits(join(priv, "ground-truth.jsonl")),
  };
  const table = buildTable(readSavedReviews(join(evidence, "reviews")), excluded);
  const patterns = findPatterns(table.rows);
  print(
    `A pattern is at least ${THRESHOLD.findings} findings with one category over ${THRESHOLD.prs} PRs in one repo.`,
  );
  if (patterns.length === 0) {
    print("No pattern over the threshold. Nothing proposed.");
    return { patterns, proposed: [], opened: [] };
  }
  const proposed = newPatterns(patterns, listTitles(lab));
  for (const pattern of patterns) {
    const status = proposed.includes(pattern) ? "new" : "already proposed";
    print(`${proposalTitle(pattern)} — ${pattern.findings.length} findings over ${pattern.prs.length} PRs (${status})`);
  }
  const opened: string[] = [];
  if (options.open) {
    for (const pattern of proposed) {
      const url = runGh(
        "issue",
        "create",
        "--repo",
        lab,
        "--title",
        proposalTitle(pattern),
        "--body",
        proposalBody(pattern, lab),
        "--label",
        "rule-proposal",
      ).trim();
      opened.push(url);
      print(`Opened ${url}`);
    }
    if (proposed.length === 0) print("Every pattern already has its proposal ticket. Nothing opened.");
  } else if (proposed.length > 0) {
    print(`Drafts only. Run with --open to open ${proposed.length} proposal ticket(s).`);
  }
  return { patterns, proposed, opened };
}

/**
 * The factory runner's step, once after a finished run. A run pushes its evidence to the private
 * repo's origin, not to this checkout, so the checkout is brought up to date first in both modes;
 * when that fails (offline, or the owner's checkout has local work) the scan runs on what is
 * there, and says so. Throws are the caller's to swallow: a proposal failure must never change
 * the run's outcome. Two concurrent `--open` runs could double-propose a pattern; the runner is
 * serialized by the tick lock, so only concurrent manual runs can race.
 */
export function proposeAfterRun(root: string, print: (line: string) => void): ProposeResult {
  const factory = loadFactory();
  try {
    execFileSync("git", ["-C", privateDir(process.env, factory, root), "pull", "--ff-only", "--quiet"], {
      timeout: 60_000,
    });
  } catch (error) {
    print(`private checkout not refreshed (${error instanceof Error ? error.message : error}); scanning as-is`);
  }
  return propose(factory, root, { open: true }, undefined, undefined, print);
}

function main(): void {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { open: { type: "boolean" } } });
  propose(loadFactory(), ROOT, { open: values.open ?? false });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

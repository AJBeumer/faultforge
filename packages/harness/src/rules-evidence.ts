/**
 * Builds one table of every Qodo finding the factory has saved, across both repos, and checks a
 * candidate rule's citations against it.
 *
 *   npm run rules:evidence                      # writes private/rules/evidence.json
 *   npm run rules:evidence -- --out <file>
 *   npm run rules:evidence -- --check <file>    # every citation in <file> must be in the table
 *
 * The table is built from the `*.review.json` files `review:wait` saves. PRs named in the private
 * case records are left out, and only their count is reported: the factory learns from its own
 * work, never from the exam.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFactory } from "./factory-config.ts";
import type { Finding } from "./review-wait.ts";

/** The parts of a saved `*.review.json` this uses. */
export interface SavedReview {
  repo: string;
  pr: number;
  headSha: string;
  reviewEffort?: string | null;
  recordedAt: string;
  findings?: Finding[];
  openFindings?: Finding[];
}

/** One finding, with where it was seen and whether the PR's last saved review still listed it. */
export interface EvidenceRow {
  id: string;
  repo: string;
  github: string;
  pr: number;
  commit: string;
  file: string | null;
  lines: [number, number] | null;
  title: string | null;
  category: string | null;
  severity: string | null;
  description: string | null;
  reviewDepth: string | null;
  recordedAt: string;
  openAtLastReview: boolean;
}

export interface EvidenceTable {
  builtAt: string;
  rows: EvidenceRow[];
  prsCovered: number;
  casePrsExcluded: number;
}

/** Case PRs as "owner/name#number", read from the case records. Missing dir means no cases. */
export function casePrs(casesDir: string): Set<string> {
  const keys = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(casesDir).filter((f) => f.endsWith(".json"));
  } catch {
    return keys;
  }
  for (const file of files) {
    const record = JSON.parse(readFileSync(join(casesDir, file), "utf8"));
    if (record?.pr?.repo && record?.pr?.number) keys.add(`${record.pr.repo}#${record.pr.number}`);
  }
  return keys;
}

/** Every saved review under `<reviewsDir>/<repoKey>-pr<N>/*.review.json`, with its repo key. */
export function readSavedReviews(reviewsDir: string): { key: string; review: SavedReview }[] {
  const out: { key: string; review: SavedReview }[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(reviewsDir);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const match = /^(.+)-pr(\d+)$/.exec(dir);
    if (!match) continue;
    for (const file of readdirSync(join(reviewsDir, dir))) {
      if (!file.endsWith(".review.json")) continue;
      out.push({ key: match[1] as string, review: JSON.parse(readFileSync(join(reviewsDir, dir, file), "utf8")) });
    }
  }
  return out;
}

/**
 * One row per finding. A finding keeps the review where it was first seen (commit, depth, time),
 * and is open only if the PR's last saved review still lists it among the open findings.
 */
export function buildTable(
  reviews: { key: string; review: SavedReview }[],
  excluded: Set<string>,
  now: () => string = () => new Date().toISOString(),
): EvidenceTable {
  const byPr = new Map<string, { key: string; review: SavedReview }[]>();
  const excludedPrs = new Set<string>();
  for (const entry of reviews) {
    const prKey = `${entry.review.repo}#${entry.review.pr}`;
    if (excluded.has(prKey)) {
      excludedPrs.add(prKey);
      continue;
    }
    byPr.set(prKey, [...(byPr.get(prKey) ?? []), entry]);
  }

  const rows: EvidenceRow[] = [];
  for (const group of byPr.values()) {
    group.sort((a, b) => a.review.recordedAt.localeCompare(b.review.recordedAt));
    const last = group[group.length - 1] as { key: string; review: SavedReview };
    const openIds = new Set((last.review.openFindings ?? []).map((f) => f.id));
    const seen = new Set<string>();
    for (const { key, review } of group) {
      for (const finding of [...(review.findings ?? []), ...(review.openFindings ?? [])]) {
        if (seen.has(finding.id)) continue;
        seen.add(finding.id);
        rows.push({
          id: finding.id,
          repo: key,
          github: review.repo,
          pr: review.pr,
          commit: review.headSha,
          file: finding.file ?? null,
          lines: finding.lines ?? null,
          title: finding.title ?? null,
          category: finding.category ?? null,
          severity: finding.severity ?? null,
          description: finding.description ?? null,
          reviewDepth: review.reviewEffort ?? null,
          recordedAt: review.recordedAt,
          openAtLastReview: openIds.has(finding.id),
        });
      }
    }
  }
  rows.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
  return { builtAt: now(), rows, prsCovered: byPr.size, casePrsExcluded: excludedPrs.size };
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PR_REF = /\b([\w-]+)#(\d+)\b/g;
const PR_URL = /github\.com\/([\w-]+\/[\w-]+)\/pull\/(\d+)/g;

/**
 * Citations in `text` that are not in the table. A citation is a finding id (UUID), a PR written
 * as `<repoKey>#<N>` (other `word#N` references are ignored), or a PR URL.
 */
export function citationProblems(text: string, table: EvidenceTable): { problems: string[]; cited: number } {
  const ids = new Set(table.rows.map((r) => r.id.toLowerCase()));
  const prs = new Set(table.rows.flatMap((r) => [`${r.repo}#${r.pr}`, `${r.github.toLowerCase()}#${r.pr}`]));
  const repoKeys = new Set(table.rows.map((r) => r.repo));
  const problems: string[] = [];
  let cited = 0;
  for (const [cite] of text.matchAll(UUID)) {
    cited++;
    if (!ids.has(cite.toLowerCase())) problems.push(`finding ${cite} is not in the table`);
  }
  for (const [, key, pr] of text.matchAll(PR_REF)) {
    if (!repoKeys.has(key as string)) continue;
    cited++;
    if (!prs.has(`${key}#${pr}`)) problems.push(`PR ${key}#${pr} is not in the table`);
  }
  for (const [, github, pr] of text.matchAll(PR_URL)) {
    cited++;
    if (!prs.has(`${(github as string).toLowerCase()}#${pr}`)) problems.push(`PR ${github}#${pr} is not in the table`);
  }
  return { problems: [...new Set(problems)], cited };
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };

  const factory = loadFactory();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const evidence = resolve(root, factory.evidence);
  const table = buildTable(readSavedReviews(join(evidence, "reviews")), casePrs(join(dirname(evidence), "cases")));

  const checkFile = flag("--check");
  if (checkFile) {
    const { problems, cited } = citationProblems(readFileSync(checkFile, "utf8"), table);
    if (problems.length) {
      console.error(`${checkFile}: ${problems.length} citation(s) not in the table:`);
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    if (cited === 0) console.log(`${checkFile}: no citations found (nothing to check)`);
    else console.log(`${checkFile}: all ${cited} citations are in the table`);
    return;
  }

  const out = flag("--out") ?? join(dirname(evidence), "rules", "evidence.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(table, null, 2)}\n`);

  const perPr = new Map<string, number>();
  for (const row of table.rows) perPr.set(`${row.repo}#${row.pr}`, (perPr.get(`${row.repo}#${row.pr}`) ?? 0) + 1);
  console.log(`${table.rows.length} findings from ${table.prsCovered} PRs -> ${out}`);
  console.log(`case PRs excluded: ${table.casePrsExcluded}`);
  for (const [pr, count] of [...perPr.entries()].sort()) console.log(`  ${pr}: ${count}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

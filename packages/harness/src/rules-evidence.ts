/**
 * Builds one table of every Qodo finding the factory has saved, across both repos, and checks a
 * candidate rule's citations against it.
 *
 *   npm run rules:evidence                      # writes private/rules/evidence.json
 *   npm run rules:evidence -- --out <file>
 *   npm run rules:evidence -- --check <file>    # every citation in <file> must be in the table
 *
 * The table is built from the `*.review.json` files `review:wait` saves. Case PRs (the exam) are
 * left out, and only their count is reported: the factory learns from its own work, never from the
 * exam. Exclusion fails closed: if the case records or the answer key can't be read, the command
 * stops instead of writing a table that might contain exam findings.
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
  state?: string;
  reviewEffort?: string | null;
  recordedAt: string;
  findings?: Finding[];
  openFindings?: Finding[];
}

/** PRs and commits that belong to cases and must never enter the table. */
export interface Excluded {
  prs: Set<string>;
  commits: Set<string>;
}

/**
 * One finding, where it was first seen in the saved archive, and whether the PR's last saved
 * complete review still listed it. `firstSeenCommit` is the head commit of the earliest saved
 * review that lists the finding, which can be later than the commit Qodo raised it on when the
 * earlier review was not saved.
 */
export interface EvidenceRow {
  id: string;
  repo: string;
  github: string;
  pr: number;
  firstSeenCommit: string;
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
  /** Every PR the table covers, including ones whose reviews found nothing: those are citable too. */
  prs: { repo: string; github: string; pr: number }[];
  prsCovered: number;
  casePrsExcluded: number;
}

/**
 * Case PRs as "owner/name#number", read from the case records. An unreadable directory is an
 * error, never an empty set: a missing exclusion list must stop the build, not weaken it.
 */
export function casePrs(casesDir: string): Set<string> {
  const keys = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(casesDir).filter((f) => f.endsWith(".json"));
  } catch (error) {
    throw new Error(`cannot read the case records at ${casesDir}: ${(error as Error).message}`);
  }
  for (const file of files) {
    const record = JSON.parse(readFileSync(join(casesDir, file), "utf8"));
    if (record?.pr?.repo && record?.pr?.number) keys.add(`${record.pr.repo}#${record.pr.number}`);
  }
  return keys;
}

/**
 * Injected commits from the answer key. A case's reviews can be saved before its case record is
 * written, so a PR is also excluded when a reviewed commit appears in the answer key. Unreadable
 * is an error, for the same reason as `casePrs`.
 */
export function groundTruthCommits(groundTruthFile: string): Set<string> {
  let text: string;
  try {
    text = readFileSync(groundTruthFile, "utf8");
  } catch (error) {
    throw new Error(`cannot read the answer key at ${groundTruthFile}: ${(error as Error).message}`);
  }
  const commits = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    for (const sha of [entry.injectionCommit, entry.reviewedCommit]) if (typeof sha === "string") commits.add(sha);
  }
  return commits;
}

/**
 * Every saved review under `<reviewsDir>/<repoKey>-pr<N>/*.review.json`, with its repo key.
 * An unreadable reviews directory is an error: an empty result would silently overwrite an
 * existing table with zero rows.
 */
export function readSavedReviews(reviewsDir: string): { key: string; review: SavedReview }[] {
  const out: { key: string; review: SavedReview }[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(reviewsDir);
  } catch (error) {
    throw new Error(`cannot read the saved reviews at ${reviewsDir}: ${(error as Error).message}`);
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
 * One row per finding. A finding keeps the review where it was first seen in the archive, and is
 * open only if the PR's last saved *complete* review still lists it among the open findings. With
 * no complete review saved for a PR, nothing there is called closed: an incomplete answer can be
 * missing findings, and absence from it is not resolution.
 */
export function buildTable(
  reviews: { key: string; review: SavedReview }[],
  excluded: Excluded,
  now: () => string = () => new Date().toISOString(),
): EvidenceTable {
  const byPr = new Map<string, { key: string; review: SavedReview }[]>();
  const excludedPrs = new Set<string>();
  for (const entry of reviews) {
    const prKey = `${entry.review.repo}#${entry.review.pr}`;
    if (excluded.prs.has(prKey) || excluded.commits.has(entry.review.headSha)) {
      excludedPrs.add(prKey);
      byPr.delete(prKey);
      continue;
    }
    if (!excludedPrs.has(prKey)) byPr.set(prKey, [...(byPr.get(prKey) ?? []), entry]);
  }

  const rows: EvidenceRow[] = [];
  for (const group of byPr.values()) {
    group.sort((a, b) => a.review.recordedAt.localeCompare(b.review.recordedAt));
    const complete = group.filter((g) => (g.review.state ?? "complete") === "complete");
    const last = complete[complete.length - 1];
    const openIds = last ? new Set((last.review.openFindings ?? []).map((f) => f.id)) : null;
    const lastCompleteAt = last?.review.recordedAt;
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
          firstSeenCommit: review.headSha,
          file: finding.file ?? null,
          lines: finding.lines ?? null,
          title: finding.title ?? null,
          category: finding.category ?? null,
          severity: finding.severity ?? null,
          description: finding.description ?? null,
          reviewDepth: review.reviewEffort ?? null,
          recordedAt: review.recordedAt,
          // A finding first seen after the last complete review can't be judged by it: stays open.
          openAtLastReview:
            !openIds || (lastCompleteAt && review.recordedAt > lastCompleteAt) ? true : openIds.has(finding.id),
        });
      }
    }
  }
  rows.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
  // Citable only with a complete review: a skipped or timed-out save proves nothing was reviewed.
  const prs = [...byPr.values()]
    .filter((group) => group.some((g) => (g.review.state ?? "complete") === "complete"))
    .map((group) => {
      const { key, review } = group[0] as { key: string; review: SavedReview };
      return { repo: key, github: review.repo, pr: review.pr };
    })
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.pr - b.pr);
  return { builtAt: now(), rows, prs, prsCovered: byPr.size, casePrsExcluded: excludedPrs.size };
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PR_REF = /\b([\w-]+)#(\d+)\b/g;
const PR_URL = /github\.com\/([\w-]+\/[\w-]+)\/pull\/(\d+)/g;
const PR_BARE = /\bPR\s+#?(\d+)\b/g;

/**
 * Citations in `text` that are not in the table. A citation is a finding id (UUID), a PR written
 * as `<repoKey>#<N>` for any configured repo key (other `word#N` references, such as tickets, are
 * ignored), a PR URL, or a bare `PR <N>`. A bare number passes only when exactly one covered PR
 * has that number; with none it is not in the table, and with several it is ambiguous.
 */
export function citationProblems(
  text: string,
  table: EvidenceTable,
  repoKeys?: Set<string>,
): { problems: string[]; cited: number } {
  const ids = new Set(table.rows.map((r) => r.id.toLowerCase()));
  const prs = new Set(table.prs.flatMap((p) => [`${p.repo}#${p.pr}`, `${p.github.toLowerCase()}#${p.pr}`]));
  const keys = repoKeys ?? new Set(table.prs.map((p) => p.repo));
  const problems: string[] = [];
  let cited = 0;
  for (const [cite] of text.matchAll(UUID)) {
    cited++;
    if (!ids.has(cite.toLowerCase())) problems.push(`finding ${cite} is not in the table`);
  }
  for (const [, key, pr] of text.matchAll(PR_REF)) {
    if (!keys.has(key as string)) continue;
    cited++;
    if (!prs.has(`${key}#${pr}`)) problems.push(`PR ${key}#${pr} is not in the table`);
  }
  for (const [, github, pr] of text.matchAll(PR_URL)) {
    cited++;
    if (!prs.has(`${(github as string).toLowerCase()}#${pr}`)) problems.push(`PR ${github}#${pr} is not in the table`);
  }
  for (const [cite, number] of text.matchAll(PR_BARE)) {
    cited++;
    const candidates = table.prs.filter((p) => p.pr === Number(number));
    if (candidates.length === 0) problems.push(`"${cite}" is not in the table`);
    else if (candidates.length > 1)
      problems.push(
        `"${cite}" is ambiguous (${candidates.map((p) => `${p.repo}#${p.pr}`).join(", ")}); name the repository`,
      );
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
  const privateDir = dirname(evidence);
  const excluded: Excluded = {
    prs: casePrs(join(privateDir, "cases")),
    commits: groundTruthCommits(join(privateDir, "ground-truth.jsonl")),
  };
  const table = buildTable(readSavedReviews(join(evidence, "reviews")), excluded);

  const checkFile = flag("--check");
  if (checkFile) {
    const { problems, cited } = citationProblems(
      readFileSync(checkFile, "utf8"),
      table,
      new Set(Object.keys(factory.repos)),
    );
    if (problems.length) {
      console.error(`${checkFile}: ${problems.length} citation(s) not in the table:`);
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    if (cited === 0) console.log(`${checkFile}: no citations found (nothing to check)`);
    else console.log(`${checkFile}: all ${cited} citations are in the table`);
    return;
  }

  const out = flag("--out") ?? join(privateDir, "rules", "evidence.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(table, null, 2)}\n`);

  const perPr = new Map<string, number>();
  for (const row of table.rows) perPr.set(`${row.repo}#${row.pr}`, (perPr.get(`${row.repo}#${row.pr}`) ?? 0) + 1);
  console.log(`${table.rows.length} findings from ${table.prsCovered} PRs -> ${out}`);
  console.log(`case PRs excluded: ${table.casePrsExcluded}`);
  for (const [pr, count] of [...perPr.entries()].sort()) console.log(`  ${pr}: ${count}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

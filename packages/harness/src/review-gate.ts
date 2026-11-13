/**
 * Says whether the exact tree a commit contains (or the staged tree) was covered by a completed local
 * review saved in the evidence, so "review before you commit" can be checked by a command and not
 * remembered.
 *
 *   npm run review:gate -- faultforge                  the staged tree
 *   npm run review:gate -- faultforge --commit HEAD    the tree of a commit
 *
 * Qodo's local review records the git tree it reviewed (`meta.checkpoint.tree_sha`, or on a first run
 * `meta.run.snapshot.tree_sha`). A commit made from exactly those files has the same tree, so the two
 * can be compared byte for byte (measured on ticket #126: the review's tree equalled the first
 * commit's). "Covered" says a complete review, not skipped, saw this tree. It does not say the
 * findings were fixed or dismissed.
 *
 * The staged tree comes from `git write-tree`, which adds the tree to the object store but changes no
 * branch, index, file, review or label. Nothing else is written.
 *
 * Exit codes: 0 covered; 1 not covered (the output names the nearest reviewed tree and its age);
 * 2 could not read the evidence or the tree (a bad option, no such commit, an unreadable folder).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { loadFactory, repoConfig } from "./factory-config.ts";
import { evidenceDir, ROOT } from "./paths.ts";

export interface ReviewRecord {
  /** The saved file this came from, relative to the evidence folder where possible. */
  source: string;
  /** Every tree hash the review recorded (a checkpoint tree, a snapshot tree, or both). */
  trees: string[];
  baseSha: string | null;
  /** The repository the review was run for (`owner/name`), when the saved run says so. */
  repo: string | null;
  /** Qodo said its coverage of the change was complete. Absent counts as not complete. */
  complete: boolean;
  /** Qodo skipped the review (`review_effort: skip`): it never really ran. */
  skipped: boolean;
  /** When the review was made, in ms: its own recorded time, else the saved file's time. */
  at: number;
}

const HASH = /^[0-9a-f]{40}$/;
const LINE_BREAK = String.fromCharCode(10);

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** What the run saved next to a review (`split.json`): which repository, and whether every changed
 * file reached Qodo. A review whose diff left a file out is never complete coverage, whatever Qodo's
 * own coverage flag says. */
export interface Sidecar {
  repo: string | null;
  scopeComplete: boolean;
}

/** Reads one parsed JSON document as a review record, or null when it is not a review with a tree.
 * Unwraps the managed-agent envelope (`{output: "<json>"}` holding `{result: payload}`) that earlier
 * saves used, and a bare `{result: payload}`. */
export function extractReviewRecord(
  doc: unknown,
  source: string,
  fileTimeMs: number,
  sidecar: Sidecar | null = null,
): ReviewRecord | null {
  let obj = asObject(doc);
  if (obj && typeof obj.output === "string") {
    try {
      obj = asObject(JSON.parse(obj.output));
    } catch {
      return null;
    }
  }
  if (obj && !obj.meta) obj = asObject(obj.result);
  const meta = asObject(obj?.meta);
  if (!meta) return null;

  const checkpoint = asObject(meta.checkpoint);
  const run = asObject(meta.run);
  const snapshot = asObject(run?.snapshot);
  const trees = [checkpoint?.tree_sha, snapshot?.tree_sha].filter(
    (t): t is string => typeof t === "string" && HASH.test(t),
  );
  if (trees.length === 0) return null;

  const effort = asObject(run?.effort);
  const baseSha = [checkpoint?.base_sha, snapshot?.base_sha].find((b): b is string => typeof b === "string") ?? null;
  const recorded = [checkpoint?.created_at, asObject(run?.timing)?.finished_at]
    .map((t) => (typeof t === "string" ? Date.parse(t) : Number.NaN))
    .find((t) => !Number.isNaN(t));
  return {
    source,
    trees: [...new Set(trees)],
    baseSha,
    // Coverage, the finding inventory and the local snapshot must all be complete: the same three
    // conditions under which `review:local` itself will not exit 3.
    complete:
      asObject(meta.coverage)?.complete === true &&
      asObject(obj?.finding_state)?.complete === true &&
      (sidecar?.scopeComplete ?? true),
    repo: sidecar?.repo ?? null,
    skipped: effort?.effective === "skip",
    at: recorded ?? fileTimeMs,
  };
}

/** Raw transport answers, never a review result: not worth parsing. */
const NOT_A_RESULT = /^(poll|result|submit|cancel)(-\d+)?\.raw\.json$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function walk(dir: string, out: string[], problems: string[], top = true): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    problems.push(`cannot list ${dir}: ${(error as Error).message.split(LINE_BREAK)[0]}`);
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    // Top-level `reviews/` holds pull-request reviews, which are never read, so a failure to list it
    // must not be reported either.
    if (entry.isDirectory()) {
      if (!(top && entry.name === "reviews")) walk(path, out, problems, false);
    } else if (entry.name.endsWith(".json") && !NOT_A_RESULT.test(entry.name)) out.push(path);
  }
}

/** The `split.json` `review:local` saved beside a `review.json`, or null when there is none (older saves).
 * The scope counts as incomplete when the diff was never built, or left any file out. */
function readSidecar(reviewFile: string): Sidecar | null {
  if (basename(reviewFile) !== "review.json") return null;
  const unknownScope: Sidecar = { repo: null, scopeComplete: false };
  try {
    const split = asObject(JSON.parse(readFileSync(join(dirname(reviewFile), "split.json"), "utf8")));
    if (!split) return unknownScope;
    const left = (v: unknown) => (Array.isArray(v) ? v.length : 1);
    const scopeComplete =
      split.diffBuilt !== false && left(split.excludedFiles ?? []) === 0 && left(split.skippedFiles ?? []) === 0;
    return { repo: typeof split.repo === "string" ? split.repo : null, scopeComplete };
  } catch (error) {
    // No split.json at all is an older save. One that exists but cannot be read or parsed is not: it
    // may have recorded a file that never reached Qodo, so the review cannot count as complete.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : unknownScope;
  }
}

/** Every saved review with a recorded tree under `root`, however deep. A file that is not JSON, is too
 * large, or holds no review is skipped, never an error: the evidence folder also holds other things. */
export function readReviewRecords(root: string): { records: ReviewRecord[]; problems: string[] } {
  const files: string[] = [];
  const problems: string[] = [];
  walk(root, files, problems);
  const records: ReviewRecord[] = [];
  for (const file of files) {
    try {
      const relative = file.slice(root.length + 1);
      // `reviews/` holds review:wait's saves of pull-request reviews, made after the push: never
      // evidence that anything was reviewed before it was committed.
      if (relative.split(sep)[0] === "reviews") continue;
      const stat = statSync(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      const rec = extractReviewRecord(
        JSON.parse(readFileSync(file, "utf8")),
        file.slice(root.length + 1),
        stat.mtimeMs,
        readSidecar(file),
      );
      if (rec) records.push(rec);
    } catch (error) {
      // Not JSON is not a review. A file git cannot read might have been one: say so.
      if (!(error instanceof SyntaxError))
        problems.push(`cannot read ${file}: ${(error as Error).message.split(LINE_BREAK)[0]}`);
    }
  }
  return { records, problems };
}

export interface GateScope {
  /** `owner/name` of the repository being checked. */
  repo?: string;
  /** Whether this checkout holds a commit: a review's base must be one. */
  hasCommit?: (sha: string) => boolean;
}

export interface GateResult {
  covered: boolean;
  /** The review that covers the tree. */
  by: ReviewRecord | null;
  /** When not covered: the most recent review of any tree, to show how stale the evidence is. */
  nearest: ReviewRecord | null;
  /** How many saved reviews were usable for this repository. Zero means there is nothing to compare
   * with, which is not the same as a tree that was not reviewed. */
  considered: number;
  reason: string;
}

/** Whether `tree` was covered. Any complete, not skipped review that recorded this exact tree
 * covers it, however old and whatever else was reviewed since. */
export function checkTree(tree: string, allRecords: ReviewRecord[], scope: GateScope = {}): GateResult {
  // A review of another repository, or one made against a base commit this checkout has never had,
  // says nothing about these files, even if the trees happen to be equal.
  const records = allRecords.filter(
    (r) =>
      !(scope.repo && r.repo && r.repo !== scope.repo) &&
      // Without a repository name, the base commit is the only link: it must be one this checkout holds.
      !(scope.hasCommit && !(r.baseSha && scope.hasCommit(r.baseSha))),
  );
  const sameTree = records.filter((r) => r.trees.includes(tree));
  const byNewest = (a: ReviewRecord, b: ReviewRecord) => b.at - a.at;
  const covering = sameTree.filter((r) => r.complete && !r.skipped).sort(byNewest)[0];
  if (covering)
    return {
      covered: true,
      by: covering,
      nearest: covering,
      considered: records.length,
      reason: "a complete review recorded this tree",
    };

  const nearest = [...records].sort(byNewest)[0] ?? null;
  if (sameTree.length > 0) {
    const why = sameTree.some((r) => r.skipped) ? "was skipped" : "had incomplete coverage";
    return {
      covered: false,
      by: null,
      nearest,
      considered: records.length,
      reason: `a review recorded this tree, but it ${why}`,
    };
  }
  return {
    covered: false,
    by: null,
    nearest,
    considered: records.length,
    reason: nearest ? "no review recorded this tree" : "no saved review with a recorded tree was found",
  };
}

/** The tree object a commit contains. Throws when the commit does not exist. */
export function treeOfCommit(repoRoot: string, commit: string): string {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${commit}^{tree}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Whether the checkout holds this commit. */
export function commitExists(repoRoot: string, sha: string): boolean {
  try {
    execFileSync("git", ["-C", repoRoot, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The tree of what is staged now. */
export function stagedTree(repoRoot: string): string {
  return execFileSync("git", ["-C", repoRoot, "write-tree"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function describeAge(ms: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export interface Args {
  repoKey: string;
  commit: string | null;
}

/** The command line, or null when it is wrong. */
export function parseArgs(argv: string[]): Args | null {
  try {
    const { values, positionals } = parseNodeArgs({
      args: argv,
      options: { commit: { type: "string" } },
      allowPositionals: true,
    });
    const [repoKey] = positionals;
    if (!repoKey || positionals.length > 1) return null;
    if (values.commit !== undefined && values.commit.trim() === "") return null;
    return { repoKey, commit: values.commit ?? null };
  } catch {
    return null;
  }
}

function main(): number {
  let factory: ReturnType<typeof loadFactory>;
  try {
    factory = loadFactory();
  } catch (error) {
    console.error(`could not read factory.json: ${(error as Error).message.split(LINE_BREAK)[0]}`);
    return 2;
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(`usage: npm run review:gate -- <${Object.keys(factory.repos).join("|")}> [--commit <sha>]`);
    return 2;
  }
  let config: ReturnType<typeof repoConfig>;
  try {
    config = repoConfig(factory, args.repoKey);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  const repoRoot = resolve(ROOT, config.path);
  const evidence = evidenceDir(factory);
  let tree: string;
  try {
    tree = args.commit !== null ? treeOfCommit(repoRoot, args.commit) : stagedTree(repoRoot);
  } catch (error) {
    console.error(`could not read the tree: ${(error as Error).message.split("\n")[0]}`);
    return 2;
  }
  if (!HASH.test(tree)) {
    console.error(`could not read the tree: git answered "${tree}"`);
    return 2;
  }
  const { records, problems } = readReviewRecords(evidence);

  const what = args.commit !== null ? `the tree of ${args.commit}` : "the staged tree";
  // One git call per distinct base commit, not one per saved review: the evidence folder only grows, and
  // the hook that runs this has ten seconds (#196).
  const known = new Map<string, boolean>();
  const hasCommit = (sha: string) => {
    if (!known.has(sha)) known.set(sha, commitExists(repoRoot, sha));
    return known.get(sha) as boolean;
  };
  const result = checkTree(tree, records, { repo: config.github, hasCommit });
  const now = Date.now();
  if (result.covered && result.by) {
    console.log(`Covered: ${what} (${tree}) was reviewed, ${describeAge(result.by.at, now)}, in ${result.by.source}.`);
    console.log("This says a complete review saw this tree, not that its findings were fixed.");
    return 0;
  }
  // A covering review would have been found even with part of the folder unreadable, but nothing else is
  // an answer unless everything was read: the missing review may be in what was not. Said first, so
  // an unreadable folder is never misreported as "no review found".
  if (problems.length > 0) {
    console.error(`could not read all of the evidence under ${evidence}, so no other answer can be trusted:`);
    for (const problem of problems.slice(0, 5)) console.error(`  ${problem}`);
    return 2;
  }
  if (result.considered === 0) {
    console.error(
      records.length === 0
        ? `no saved review with a recorded tree under ${evidence}`
        : `none of the ${records.length} saved review(s) belongs to ${config.github} with a base commit this checkout holds, so there is nothing to compare with`,
    );
    return 2;
  }
  console.log(`Not covered: ${what} (${tree}); ${result.reason}.`);
  if (result.nearest) {
    console.log(
      `Nearest review: tree ${result.nearest.trees[0]}, ${describeAge(result.nearest.at, now)}, in ${result.nearest.source}.`,
    );
  }
  return 1;
}

// Run only when called as a script, not when the tests import it.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main();
}

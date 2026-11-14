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
 * branch, index, file, review or label. The only other write is a cache of what each saved review held, under
 * `node_modules/.cache/` (`review-gate-cache.ts`), so a commit parses only the reviews saved since the last one.
 *
 * Exit codes: 0 covered; 1 not covered (the output names the nearest reviewed tree and its age);
 * 2 could not read the evidence or the tree (a bad option, no such commit, an unreadable folder).
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { loadFactory, repoConfig } from "./factory-config.ts";
import { evidenceDir, ROOT } from "./paths.ts";
import { defaultCacheFile, ReviewCache } from "./review-gate-cache.ts";
import { HASH, LINE_BREAK, type ReviewRecord, readReviewRecords } from "./review-gate-records.ts";

export { extractReviewRecord, type ReviewRecord, readReviewRecords, type Sidecar } from "./review-gate-records.ts";

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
    const skipped = sameTree.some((r) => r.skipped);
    const newest = [...sameTree].sort(byNewest)[0] as ReviewRecord;
    const why = skipped
      ? "was skipped"
      : `was incomplete: ${newest.incompleteBecause ?? "its coverage was incomplete"}`;
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
  const cache = ReviewCache.load(defaultCacheFile(evidence, ROOT));
  const { records, problems } = readReviewRecords(evidence, cache);
  cache.save();

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
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`review:gate could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

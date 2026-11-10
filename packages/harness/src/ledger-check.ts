/**
 * Checks that the answer key and the audit log are still append-only, and that every amendment in
 * them is sound.
 *
 *   npm run ledger:check
 *
 * Runs `ledgerProblems` (see `ledger.ts`) on both files, then asks the private repo's git history,
 * including merge commits, and its uncommitted state, whether any commit (or anything not yet
 * committed) removed or changed a line of either file: every commit may only add lines.
 *
 * Exit codes: 0 both files are sound; 1 problems found, listed on stdout; 2 a file or the private
 * repo's git history could not be read.
 */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerProblems } from "./ledger.ts";
import { privateDir } from "./templates.ts";

const FILES = ["ground-truth.jsonl", "audit-events.jsonl"];

const DIFF_HEADER = /^(diff --git|index |--- |\+\+\+ )/;

/** True when a unified diff's hunk lines (after `@@`) contain a real removal, never a header line. */
function removesALine(diffText: string): boolean {
  let inHunk = false;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (DIFF_HEADER.test(line)) continue;
    if (!inHunk) continue;
    // A real removal or change; "\ No newline at end of file" is neither and carries no content.
    if (line.startsWith("-") && !line.startsWith("\\")) return true;
  }
  return false;
}

/** The private repo's own root for `repoRoot`, or throws when it isn't inside its own git repository. */
function ownRepoRoot(repoRoot: string): string {
  let toplevel: string;
  try {
    toplevel = execFileSync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`${repoRoot} is not inside a git repository: ${(error as Error).message}`);
  }
  if (resolve(toplevel) !== resolve(repoRoot)) {
    throw new Error(`${repoRoot} is not the root of its own git repository (git found ${toplevel} instead)`);
  }
  return toplevel;
}

/**
 * Problems from a file's git history and working tree: one entry per commit (including a merge's own
 * resolution, via `-m`) whose diff for `relPath` removed or changed a line instead of only adding
 * them, plus one entry if the working tree or index holds an uncommitted removal or change.
 * `--follow` so a rename doesn't hide older history.
 */
export function appendOnlyProblems(repoRoot: string, relPath: string): string[] {
  ownRepoRoot(repoRoot);
  const problems: string[] = [];

  let headExists: boolean;
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" });
    headExists = true;
  } catch {
    headExists = false; // no commit yet, so no committed history to have broken the rule
  }

  if (headExists) {
    let log: string;
    try {
      log = execFileSync("git", ["-C", repoRoot, "log", "--no-color", "--follow", "-p", "-m", "--", relPath], {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`git log failed for ${relPath}: ${(error as Error).message}`);
    }
    for (const commitDiff of log.split(/^commit /m).slice(1)) {
      const sha = (commitDiff.match(/^([0-9a-f]+)/)?.[1] ?? "unknown").slice(0, 12);
      if (removesALine(commitDiff)) problems.push(`${relPath}: commit ${sha} removed or changed a line`);
    }

    let uncommitted: string;
    try {
      uncommitted = execFileSync("git", ["-C", repoRoot, "diff", "--no-color", "HEAD", "--", relPath], {
        encoding: "utf8",
        timeout: 60_000,
      });
    } catch (error) {
      throw new Error(`git diff failed for ${relPath}: ${(error as Error).message}`);
    }
    if (removesALine(uncommitted)) problems.push(`${relPath}: uncommitted changes removed or changed a line`);
  }

  return problems;
}

/** Every problem with the private ledger: unsound amendments plus any non-append-only history. */
export function ledgerCheckProblems(privateRoot: string): string[] {
  const problems: string[] = [];
  for (const file of FILES) {
    problems.push(...ledgerProblems(join(privateRoot, file)));
    problems.push(...appendOnlyProblems(privateRoot, file));
  }
  return problems;
}

function main() {
  const root = privateDir();
  let problems: string[];
  try {
    problems = ledgerCheckProblems(root);
  } catch (error) {
    console.error(`[ledger:check] could not read a file or the private repo's history: ${(error as Error).message}`);
    process.exit(2);
  }
  if (problems.length) {
    console.log(`[ledger:check] problems found:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("[ledger:check] both files are sound: amendments check out, history is append-only");
  process.exit(0);
}

// Run only when called as a script, not when the tests import it.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();

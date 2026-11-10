/**
 * Checks that the answer key and the audit log are still append-only, and that every amendment in
 * them is sound.
 *
 *   npm run ledger:check
 *
 * Runs `ledgerProblems` (see `ledger.ts`) on both files, then asks the private repo's git history
 * whether any commit removed or changed a line of either file: every commit may only add lines.
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

/**
 * Problems from a file's git history: one entry per commit whose diff for `relPath` removed or
 * changed a line, instead of only adding them. `--follow` so a rename doesn't hide older history.
 */
export function appendOnlyProblems(repoRoot: string, relPath: string): string[] {
  try {
    execFileSync("git", ["-C", repoRoot, "rev-parse", "--quiet", "--verify", "HEAD"], { encoding: "utf8" });
  } catch {
    return []; // no commit yet, so no history to have broken the rule
  }
  let output: string;
  try {
    output = execFileSync("git", ["-C", repoRoot, "log", "--no-color", "--follow", "-p", "--", relPath], {
      encoding: "utf8",
      timeout: 60_000,
    });
  } catch (error) {
    throw new Error(`git log failed for ${relPath}: ${(error as Error).message}`);
  }
  const problems: string[] = [];
  let commit = "";
  let inHunk = false;
  let flaggedThisCommit = false;
  for (const line of output.split("\n")) {
    if (line.startsWith("commit ")) {
      commit = line.slice("commit ".length).trim().slice(0, 12);
      inHunk = false;
      flaggedThisCommit = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      continue;
    }
    if (!inHunk) continue;
    // A real removal or change; "\ No newline at end of file" is neither and carries no content.
    if (line.startsWith("-") && !line.startsWith("\\") && !flaggedThisCommit) {
      problems.push(`${relPath}: commit ${commit} removed or changed a line`);
      flaggedThisCommit = true;
    }
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

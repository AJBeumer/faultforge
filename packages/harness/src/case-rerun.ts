/**
 * Marks a case as a rerun of another, by appending one amendment to the answer key (AUD-M13). It never edits
 * a line: the earlier entry stays as it was, and the rerun's entry gains `rerunOf` when the file is read.
 *
 *   npm run case:rerun -- FF-0019 --of FF-0015
 *   npm run case:rerun -- FF-0019 --of FF-0015 --dry-run     # prints the amendment, writes nothing
 *
 * Both must be bug cases planted from the same template, and their injection commits must hold the very
 * same tree in the target repository (`git rev-parse <commit>^{tree}`): then the second planted nothing the
 * first didn't, and the two count as one distinct defect. A case already marked, a case marked as its own
 * rerun, and a rerun of a case that is itself a rerun are refused. The amendment's evidence names both
 * commits and the shared tree, so anyone can check it.
 *
 * `ledger:check` accepts the result: `rerunOf` is not a locked field. Published records are unchanged: their
 * schema has no field for it, and `case:build` doesn't read it.
 *
 * Exit codes: 0 the amendment was appended (or, with `--dry-run`, printed); 1 refused: usage, a case is
 * missing or isn't a bug case, the templates or the trees differ, or a case is already marked; 2 couldn't
 * run: the answer key or audit log has a problem, git couldn't read a commit, or the line couldn't be
 * appended.
 */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { errorText as message } from "./error-text.ts";
import { loadFactory, repoConfig } from "./factory-config.ts";
import { type LedgerEntry, readLedger } from "./ledger.ts";
import { appendAmendment } from "./ledger-append.ts";
import { ledgerProblemsWithHistory } from "./ledger-check.ts";
import { ROOT } from "./paths.ts";
import { privateDir } from "./templates.ts";

export const RERUN_REASON = "Marks a rerun: the same template planted the same tree again, so both are one defect.";

export interface RerunArgs {
  caseId: string;
  of: string;
  dryRun: boolean;
}

/** The command line, or null when it's wrong. */
export function parseCliArgs(argv: string[]): RerunArgs | null {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { of: { type: "string" }, "dry-run": { type: "boolean" } },
      allowPositionals: true,
    });
    const [caseId] = positionals;
    const ids = [caseId, values.of];
    if (positionals.length !== 1 || !ids.every((id) => typeof id === "string" && /^FF-\d{4}$/.test(id))) return null;
    return { caseId: caseId as string, of: values.of as string, dryRun: values["dry-run"] ?? false };
  } catch {
    return null;
  }
}

export interface RerunOptions {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** The tree a target commit holds; throws when git can't read it. */
  treeOf?: (commit: string) => string;
  now?: () => string;
}

function liveTreeOf(commit: string): string {
  const target = resolve(ROOT, repoConfig(loadFactory(), "target").path);
  return execFileSync("git", ["-C", target, "rev-parse", "--verify", `${commit}^{tree}`], { encoding: "utf8" }).trim();
}

export function run(args: RerunArgs, options: RerunOptions = {}): number {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const error = options.error ?? ((line: string) => console.error(line));
  const root = privateDir(env);
  const groundTruthPath = join(root, "ground-truth.jsonl");
  const refuse = (why: string) => {
    error(`case:rerun: refused, ${why}; nothing written`);
    return 1;
  };

  const problems = ledgerProblemsWithHistory([groundTruthPath, join(root, "audit-events.jsonl")]);
  if (problems.length) {
    error(`case:rerun: the answer key or audit log has problems:\n${problems.map((p) => `- ${p}`).join("\n")}`);
    return 2;
  }
  let entries: LedgerEntry[];
  try {
    entries = readLedger(groundTruthPath);
  } catch (e) {
    error(`case:rerun: can't read ${groundTruthPath}: ${message(e)}`);
    return 2;
  }
  if (args.caseId === args.of) return refuse("a case can't be a rerun of itself");
  const rerun = entries.find((e) => e.caseId === args.caseId);
  const original = entries.find((e) => e.caseId === args.of);
  if (!rerun || !original) return refuse(`${rerun ? args.of : args.caseId} is not in the answer key`);
  for (const entry of [rerun, original]) {
    if (entry.kind !== "sabotage") return refuse(`${String(entry.caseId)} is not a bug case`);
    if (typeof entry.injectionCommit !== "string") return refuse(`${String(entry.caseId)} has no injection commit`);
  }
  if (rerun.rerunOf !== undefined)
    return refuse(`${args.caseId} is already marked a rerun of ${String(rerun.rerunOf)}`);
  if (original.rerunOf !== undefined) {
    return refuse(`${args.of} is itself a rerun of ${String(original.rerunOf)}: mark it against that case`);
  }
  if (rerun.templateId !== original.templateId) {
    return refuse(
      `${args.caseId} planted ${String(rerun.templateId)}, ${args.of} planted ${String(original.templateId)}`,
    );
  }
  let trees: [string, string];
  try {
    const treeOf = options.treeOf ?? liveTreeOf;
    trees = [treeOf(rerun.injectionCommit as string), treeOf(original.injectionCommit as string)];
  } catch (e) {
    error(`case:rerun: git can't read an injection commit: ${message(e)}`);
    return 2;
  }
  if (trees[0] !== trees[1]) return refuse(`their injection commits hold different trees (${trees[0]}, ${trees[1]})`);

  const amendment = {
    amends: args.caseId,
    at: (options.now ?? (() => new Date().toISOString()))(),
    change: { rerunOf: args.of },
    reason: RERUN_REASON,
    evidence: `target commits ${String(rerun.injectionCommit)} and ${String(original.injectionCommit)} both hold tree ${trees[0]}`,
  };
  if (args.dryRun) {
    log(`(dry run) would append to ${groundTruthPath}:`);
    log(JSON.stringify({ kind: "amendment", ...amendment }, null, 2));
    return 0;
  }
  try {
    appendAmendment(groundTruthPath, amendment);
  } catch (e) {
    error(`case:rerun: can't append to ${groundTruthPath}: ${message(e)}`);
    return 2;
  }
  log(`marked: ${args.caseId} is a rerun of ${args.of}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed) {
    console.error("usage: npm run case:rerun -- <FF-NNNN> --of <FF-NNNN> [--dry-run]");
    process.exit(1);
  }
  try {
    process.exit(run(parsed));
  } catch (e) {
    console.error(`case:rerun: ${message(e)}`);
    process.exit(2);
  }
}

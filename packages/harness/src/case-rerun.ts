/**
 * Marks a case as a rerun of another, by appending one amendment to the answer key (AUD-M13). It never edits
 * a line: the earlier entry stays as it was, and the rerun's entry gains `rerunOf` when the file is read.
 *
 *   npm run case:rerun -- FF-0019 --of FF-0015
 *   npm run case:rerun -- FF-0019 --of FF-0015 --dry-run           # prints the amendment, writes nothing
 *   npm run case:rerun -- FF-0019 --of FF-0015 --target <checkout>  # read the commits from another checkout
 *
 * Both must be bug cases planted from the same template, and their injection commits must hold the very
 * same tree in the target repository (`git rev-parse <commit>^{tree}`, in `factory.json`'s target checkout
 * unless `--target` names another): then the second planted nothing the first didn't, and the two count as
 * one distinct defect. Refused: a case already marked, a case marked as its own rerun, a rerun of a case that
 * is itself a rerun, and marking a case that another case already names as its original (no chains). The
 * marks are checked again under the answer key's lock, just before writing, so two runs can't both succeed.
 * The amendment's evidence names both commits and the shared tree, so anyone can check it.
 *
 * `ledger:check` accepts the result: `rerunOf` is not a locked field. Published records are unchanged: their
 * schema has no field for it, and `case:build` doesn't read it.
 *
 * Exit codes: 0 the amendment was appended (or, with `--dry-run`, printed); 1 refused: usage, a case is
 * missing or isn't a bug case, the templates or the trees differ, or the marks would chain or are already
 * there; 2 couldn't run: the answer key or audit log has a problem, git couldn't read a commit, or the line
 * couldn't be appended.
 *
 * An unexpected error, even while loading, is 2 too: `npm run case:rerun` runs `case-rerun-cli.ts`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { errorText as message } from "./error-text.ts";
import { loadFactory, repoConfig } from "./factory-config.ts";
import { type LedgerEntry, readAuditLog, readLedger } from "./ledger.ts";
import { appendAmendment, readEventProblems } from "./ledger-append.ts";
import { ledgerProblemsWithHistory } from "./ledger-check.ts";
import { hashProblems } from "./ledger-hashes.ts";
import { ROOT } from "./paths.ts";
import { savedReviewsDir } from "./saved-review.ts";
import { privateDir } from "./templates.ts";

export const RERUN_REASON = "Marks a rerun: the same template planted the same tree again, so both are one defect.";

export interface RerunArgs {
  caseId: string;
  of: string;
  dryRun: boolean;
  /** The target checkout to read the commits from; `factory.json`'s when absent. */
  target?: string;
}

/** The command line, or null when it's wrong. */
export function parseCliArgs(argv: string[]): RerunArgs | null {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { of: { type: "string" }, "dry-run": { type: "boolean" }, target: { type: "string" } },
      allowPositionals: true,
    });
    const [caseId] = positionals;
    const ids = [caseId, values.of];
    if (positionals.length !== 1 || !ids.every((id) => typeof id === "string" && /^FF-\d{4}$/.test(id))) return null;
    return {
      caseId: caseId as string,
      of: values.of as string,
      dryRun: values["dry-run"] ?? false,
      ...(values.target ? { target: values.target } : {}),
    };
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

function liveTreeOf(target: string | undefined): (commit: string) => string {
  const dir = target ? resolve(target) : resolve(ROOT, repoConfig(loadFactory(), "target").path);
  return (commit) =>
    execFileSync("git", ["-C", dir, "rev-parse", "--verify", `${commit}^{tree}`], { encoding: "utf8" }).trim();
}

/** Why the answer key can't take this mark, or undefined: both cases, their kinds, and no mark that would chain. */
export function markProblem(entries: LedgerEntry[], caseId: string, of: string): string | undefined {
  if (caseId === of) return "a case can't be a rerun of itself";
  const rerun = entries.find((e) => e.caseId === caseId);
  const original = entries.find((e) => e.caseId === of);
  if (!rerun || !original) return `${rerun ? of : caseId} is not in the answer key`;
  for (const entry of [rerun, original]) {
    if (entry.kind !== "sabotage") return `${String(entry.caseId)} is not a bug case`;
    if (typeof entry.injectionCommit !== "string") return `${String(entry.caseId)} has no injection commit`;
  }
  if (rerun.rerunOf !== undefined) return `${caseId} is already marked a rerun of ${String(rerun.rerunOf)}`;
  if (original.rerunOf !== undefined) {
    return `${of} is itself a rerun of ${String(original.rerunOf)}: mark it against that case`;
  }
  // No chains the other way either: a case another names as its original stays an original (Qodo on PR 273).
  const named = entries.find((e) => e.rerunOf === caseId);
  if (named) return `${String(named.caseId)} is already marked a rerun of ${caseId}, so ${caseId} stays an original`;
  // A missing template on both sides is no evidence of the same template (Qodo on PR 273).
  for (const entry of [rerun, original]) {
    if (typeof entry.templateId !== "string" || !entry.templateId) return `${String(entry.caseId)} names no template`;
  }
  if (rerun.templateId !== original.templateId) {
    return `${caseId} planted ${String(rerun.templateId)}, ${of} planted ${String(original.templateId)}`;
  }
  return undefined;
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

  const auditEventsPath = join(root, "audit-events.jsonl");
  // Everything ledger:check would report, not only the amendments and the history (Qodo on PR 273): every
  // event readable, and every tool's inputHash still recomputing.
  let problems: string[];
  try {
    problems = [
      ...ledgerProblemsWithHistory([groundTruthPath, auditEventsPath]),
      ...(existsSync(auditEventsPath) ? readAuditLog(auditEventsPath).flatMap((e) => readEventProblems(e) ?? []) : []),
      ...(existsSync(auditEventsPath)
        ? hashProblems({ groundTruthPath, auditEventsPath, reviewsDir: savedReviewsDir(env) }, env)
        : []),
    ];
  } catch (e) {
    problems = [`the files can't be read: ${message(e)}`];
  }
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
  const problem = markProblem(entries, args.caseId, args.of);
  if (problem) return refuse(problem);
  const rerunCommit = entries.find((e) => e.caseId === args.caseId)?.injectionCommit as string;
  const originalCommit = entries.find((e) => e.caseId === args.of)?.injectionCommit as string;
  let trees: [string, string];
  try {
    const treeOf = options.treeOf ?? liveTreeOf(args.target);
    trees = [treeOf(rerunCommit), treeOf(originalCommit)];
  } catch (e) {
    error(`case:rerun: git can't read an injection commit (pass --target for another checkout): ${message(e)}`);
    return 2;
  }
  if (trees[0] !== trees[1]) return refuse(`their injection commits hold different trees (${trees[0]}, ${trees[1]})`);

  const amendment = {
    amends: args.caseId,
    at: (options.now ?? (() => new Date().toISOString()))(),
    change: { rerunOf: args.of },
    reason: RERUN_REASON,
    evidence: `target commits ${rerunCommit} and ${originalCommit} both hold tree ${trees[0]}`,
  };
  if (args.dryRun) {
    log(`(dry run) would append to ${groundTruthPath}:`);
    log(JSON.stringify({ kind: "amendment", ...amendment }, null, 2));
    return 0;
  }
  let raced: string | undefined;
  try {
    // Checked again under the lock: another run may have marked either case meanwhile (Qodo on PR 273).
    appendAmendment(groundTruthPath, amendment, () => {
      raced = markProblem(readLedger(groundTruthPath), args.caseId, args.of);
      if (raced) throw new Error(raced);
    });
  } catch (e) {
    if (raced) return refuse(raced);
    error(`case:rerun: can't append to ${groundTruthPath}: ${message(e)}`);
    return 2;
  }
  log(`marked: ${args.caseId} is a rerun of ${args.of}`);
  return 0;
}

/** The command: `case-rerun-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(argv: string[]): number {
  const parsed = parseCliArgs(argv);
  if (!parsed) {
    console.error("usage: npm run case:rerun -- <FF-NNNN> --of <FF-NNNN> [--dry-run] [--target <checkout>]");
    return 1;
  }
  return run(parsed);
}

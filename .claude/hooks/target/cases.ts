/**
 * What may not be done to a recorded case's refs in a reviewed checkout. CLAUDE.md: never rewrite
 * the reviewed repo's history, which cases record as evidence. Refused in a reviewed checkout: `git update-ref`
 * (plumbing no ordinary work needs), and deleting, renaming or force-moving a recorded case branch
 * (`git branch -D`, `-m`, `-f`, `checkout -B`, `switch -C`).
 *
 * Merging a case PR, addressing Qodo there, and any other write to the reviewed repo are refused before this runs:
 * every write to it goes through `npm run target:post`, which has no merge and refuses text that addresses
 * Qodo. So this module doesn't read gh calls or MCP tools.
 *
 * Case branches are the `branch` of every audit event and answer-key entry. Where private storage has no audit log,
 * nothing can be told apart: a branch change is refused. Branch names are never printed: one could be a private
 * template's.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { privateRoot } from "../answer-key/private-ids.ts";
import { checkoutAt, locate, type Reviewed } from "../shared/repos.ts";
import { type Call, calls } from "./history.ts";
import type { Context } from "./tools.ts";

/** What private storage records about cases: every case branch, in lower case. */
export interface CaseRecords {
  branches: Set<string>;
}

/** Each JSON object of a JSONL file; a line that isn't one is skipped. */
function objects(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
}

/**
 * The recorded cases. Where there is no private folder (public CI, a fresh clone) there are none to protect; a
 * private folder without its audit log can't tell, so that is undefined.
 */
export function caseRecords(env: NodeJS.ProcessEnv): CaseRecords | undefined {
  const root = privateRoot(env);
  const audit = join(root, "audit-events.jsonl");
  const records: CaseRecords = { branches: new Set() };
  if (!existsSync(root)) return records;
  if (!existsSync(audit)) return undefined;
  for (const entry of [...objects(audit), ...objects(join(root, "ground-truth.jsonl"))]) {
    if (typeof entry.branch === "string" && entry.branch) records.branches.add(entry.branch.toLowerCase());
  }
  return records;
}

const BRANCH_REASON =
  "This would delete, rename or move a recorded case branch, or a ref the guard can't tell from one, in a reviewed checkout. Cases record those refs as evidence.";
const UPDATE_REF = "No `git update-ref` in a reviewed checkout: cases record its refs as evidence.";

/** The branch a checkout is on, lower case, or undefined when it can't be read. */
function currentBranch(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const r = spawnSync("git", ["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"], { encoding: "utf8", timeout: 4000 });
  return r.status === 0 ? r.stdout.trim().toLowerCase() : undefined;
}

/** Why a git call in a reviewed checkout deletes, renames or moves a case branch, or undefined. */
function refProblem(call: Call, records: CaseRecords | undefined): string | undefined {
  const [sub = "", ...rest] = call.args;
  if (sub === "update-ref") return UPDATE_REF;
  const names = rest.filter((w) => !w.startsWith("-"));
  const recorded = (name: string | undefined) =>
    !records || name === undefined || /[$`%]/.test(name) || records.branches.has(name.toLowerCase());
  if (sub === "branch") {
    const changes = rest.some((w) => /^(-[a-zA-Z]*[dDmMf][a-zA-Z]*|--delete|--move|--force)$/.test(w));
    if (!changes) return undefined;
    // `-m new` renames the branch the checkout is on.
    const moved = rest.some((w) => /^(-[a-zA-Z]*[mM]|--move)$/.test(w)) && names.length < 2;
    const targets = moved ? [currentBranch(call.dir), ...names] : names.length ? names : [undefined];
    return targets.some(recorded) ? BRANCH_REASON : undefined;
  }
  if (sub === "checkout" || sub === "switch") {
    // The name may be its own word or joined on (`-Btidy`, `--force-create=tidy`).
    for (let i = 0; i < rest.length; i++) {
      const force = /^(?:-B|-C|--force-create)(?:=?)(.*)$/.exec(rest[i] ?? "");
      if (force && recorded(force[1] || rest[i + 1])) return BRANCH_REASON;
    }
  }
  return undefined;
}

/** Why a command deletes, renames or moves a case branch in reviewed repo `repo`'s checkout, or undefined. */
export function caseActionProblem(ctx: Context, command: string, repo: Reviewed): string | undefined {
  // The whole command: a flag that is a message elsewhere (`-m`) is git branch's rename here.
  let records: CaseRecords | undefined | null = null;
  for (const call of calls(command, ctx.cwd, ctx.backticks)) {
    if (call.program !== "git") continue;
    // Only in the reviewed checkout, or a folder the guard can't follow.
    const here = call.dir === undefined || locate(call.dir, ctx.reviewed)?.github === repo.github;
    if (!here || (call.dir !== undefined && checkoutAt(call.dir) === undefined)) continue;
    if (call.args[0] !== "update-ref" && records === null) records = caseRecords(ctx.env);
    const problem = refProblem(call, records ?? undefined);
    if (problem) return problem;
  }
  return undefined;
}

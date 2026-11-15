/**
 * What may not be done to a recorded case in a reviewed repo (re-grade 6, Q23 to Q26, H15). CLAUDE.md: never
 * merge a case PR, never chat with Qodo on one, and never rewrite the reviewed repo's history, which cases
 * record as evidence. Refused:
 *  - merging a recorded case PR: `gh pr merge` by number, URL or branch (or with none, from the case branch), the
 *    REST merge call (`pulls/<n>/merge`), and the GraphQL merge mutations, whose node ids the guard can't map, so
 *    those are refused for every PR. Closing a case PR with an ordinary comment stays allowed; deleting its branch
 *    as it closes (`gh pr close -d`) does not;
 *  - any post to a reviewed repo that addresses Qodo: `@qodo…`, or a line that starts with one of its commands
 *    (`/ask`, `/review`, `/improve`, …). Qodo learns from every chat in the repo, which would bias later cases, so
 *    this holds for every PR and issue there, not only case PRs;
 *  - in a reviewed checkout, `git update-ref` (plumbing no ordinary work needs), and deleting, renaming or
 *    force-moving a recorded case branch (`git branch -D`, `-m`, `-f`, `checkout -B`, `switch -C`).
 * Case PRs are the `pr.opened` events of the audit log; case branches are the `branch` of every audit event and
 * answer-key entry. Where private storage has no audit log, nothing can be told apart: a merge or a branch change is
 * refused. Numbers and branch names are never printed: a branch's name could be a private template's.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { referencedFiles } from "./guard-files.ts";
import { type Call, calls } from "./guard-history.ts";
import { outsidePostedText } from "./guard-posted.ts";
import { privateRoot } from "./guard-private.ts";
import { checkoutAt, githubRepos, locate, type Reviewed } from "./guard-repos.ts";
import type { Context } from "./guard-tools.ts";

/** What private storage records about cases: each repo's case PR numbers, and every case branch, in lower case. */
export interface CaseRecords {
  prs: Map<string, Set<number>>;
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
  const records: CaseRecords = { prs: new Map(), branches: new Set() };
  if (!existsSync(root)) return records;
  if (!existsSync(audit)) return undefined;
  for (const entry of [...objects(audit), ...objects(join(root, "ground-truth.jsonl"))]) {
    if (typeof entry.branch === "string" && entry.branch) records.branches.add(entry.branch.toLowerCase());
    if (entry.type === "pr.opened" && typeof entry.repo === "string" && Number.isInteger(entry.pr)) {
      const repo = entry.repo.toLowerCase();
      const numbers = records.prs.get(repo) ?? new Set<number>();
      numbers.add(entry.pr as number);
      records.prs.set(repo, numbers);
    }
  }
  return records;
}

const MERGE_REASON =
  "This would merge a recorded case PR, or one the guard can't tell from one. A case PR is never merged: close it with an ordinary comment.";
const BRANCH_REASON =
  "This would delete, rename or move a recorded case branch, or a ref the guard can't tell from one, in a reviewed checkout. Cases record those refs as evidence.";
const REPO_REASON =
  "This would rename, archive or delete a reviewed repo, or change its settings by API. Its history and PRs are the cases' evidence: the owner does that by hand.";
const UPDATE_REF = "No `git update-ref` in a reviewed checkout: cases record its refs as evidence.";

/** The positional words of a gh call after its first `skip` words, skipping the values of `valued` options. */
function positionals(args: string[], skip: number, valued: RegExp): string[] {
  const out: string[] = [];
  for (let i = skip; i < args.length; i++) {
    const word = args[i] ?? "";
    if (valued.test(word)) i++;
    else if (!word.startsWith("-")) out.push(word);
  }
  return out;
}

/** The branch a checkout is on, lower case, or undefined when it can't be read. */
function currentBranch(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  const r = spawnSync("git", ["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"], { encoding: "utf8", timeout: 4000 });
  return r.status === 0 ? r.stdout.trim().toLowerCase() : undefined;
}

/** True when a gh PR word names a recorded case PR in `repo`, or can't be read. */
function namesCasePr(word: string | undefined, call: Call, repo: Reviewed, records: CaseRecords): boolean {
  const numbers = records.prs.get(repo.github.toLowerCase()) ?? new Set<number>();
  if (word === undefined) {
    const branch = currentBranch(call.dir);
    return branch === undefined || records.branches.has(branch);
  }
  if (/[$`%]/.test(word)) return true;
  const url = /\/pull\/(\d+)/.exec(word);
  if (url) return githubRepos(word).some((r) => r !== repo.github.toLowerCase()) ? false : numbers.has(Number(url[1]));
  if (/^#?\d+$/.test(word)) return numbers.has(Number(word.replace("#", "")));
  return records.branches.has(word.toLowerCase());
}

/** The gh pr options that take a value. */
const PR_VALUED =
  /^(-R|--repo|-b|--body|-F|--body-file|-t|--subject|-A|--author-email|--match-head-commit|-c|--comment)$/;

/** Why a gh call merges a case PR, or undefined. */
function mergeProblem(call: Call, repo: Reviewed, records: CaseRecords | undefined): string | undefined {
  const [sub = "", verb = ""] = call.args;
  if (sub !== "pr" || !/^(merge|close)$/.test(verb)) return undefined;
  // Closing stays allowed; deleting the branch as it closes does not.
  if (verb === "close" && !call.args.some((w) => /^(-d|--delete-branch)$/.test(w))) return undefined;
  if (!records) return verb === "merge" ? MERGE_REASON : BRANCH_REASON;
  const named = namesCasePr(positionals(call.args, 2, PR_VALUED)[0], call, repo, records);
  return named ? (verb === "merge" ? MERGE_REASON : BRANCH_REASON) : undefined;
}

/** Why a git call in a reviewed checkout deletes, renames or moves a case branch, or undefined (H15). */
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
    // The name may be its own word or joined on (`-Btidy`, `--force-create=tidy`; Qodo on PR 337).
    for (let i = 0; i < rest.length; i++) {
      const force = /^(?:-B|-C|--force-create)(?:=?)(.*)$/.exec(rest[i] ?? "");
      if (force && recorded(force[1] || rest[i + 1])) return BRANCH_REASON;
    }
  }
  return undefined;
}

/** The GraphQL mutations that merge a PR. */
const GRAPHQL_MERGE = /\b(mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch)\b/;

/**
 * Why a command that reaches reviewed repo `repo` merges a case PR, or deletes, renames or moves a case branch in
 * its checkout, or undefined. `runsIn` is true when the command runs in that checkout.
 */
export function caseActionProblem(ctx: Context, command: string, repo: Reviewed): string | undefined {
  const outside = outsidePostedText(command);
  // The whole command: a flag that is a message elsewhere (`-m`) is git branch's rename here.
  const found = calls(command, ctx.cwd, ctx.backticks);
  let records: CaseRecords | undefined | null = null;
  const read = () => {
    if (records === null) records = caseRecords(ctx.env);
    return records;
  };
  for (const call of found) {
    if (call.program === "gh" && call.args[0] === "repo" && /^(rename|delete|archive)$/.test(call.args[1] ?? ""))
      return REPO_REASON;
    if (call.program === "gh" && call.args[0] === "api") {
      const texts = [command, ...referencedFiles(ctx.cwd, command)];
      if (/\bgraphql\b/.test(outside) && texts.some((t) => GRAPHQL_MERGE.test(t))) return MERGE_REASON;
      // gh api reads by default, and writes once it is given a field, an input or another method.
      // gh sends the last method given (Qodo on PR 337).
      const method = [...command.matchAll(/(?:-X|--method)[\s=]*["']?(\w+)/gi)].at(-1)?.[1];
      const reads = method ? /^get$/i.test(method) : !/\s(-f|-F|--field|--raw-field|--input)\b/.test(command);
      // The repo itself, renamed, archived or deleted: `repos/<owner>/<name>` and nothing after it.
      if (!reads && /(^|[\s"'/])repos\/[\w.-]+\/[\w.-]+\/?(?=["'\s?]|$)/.test(outside)) return REPO_REASON;
      const merge = /pulls\/([^/\s"']+)\/merge\b/.exec(outside);
      if (merge && !reads) {
        const known = read();
        const prs = known?.prs.get(repo.github.toLowerCase()) ?? new Set<number>();
        if (!known || !/^\d+$/.test(merge[1] ?? "") || prs.has(Number(merge[1]))) return MERGE_REASON;
      }
    }
    if (call.program === "gh") {
      const problem = mergeProblem(call, repo, read());
      if (problem) return problem;
    }
    if (call.program === "git") {
      // Only in the reviewed checkout, or a folder the guard can't follow.
      const here = call.dir === undefined || locate(call.dir, ctx.reviewed)?.github === repo.github;
      const inRepo = here && (call.dir === undefined || checkoutAt(call.dir) !== undefined);
      if (!inRepo) continue;
      const problem = refProblem(call, /^(update-ref)$/.test(call.args[0] ?? "") ? undefined : read());
      if (problem) return problem;
    }
  }
  return undefined;
}

/**
 * Why an MCP tool's call on reviewed repo `repo` merges a case PR or deletes or moves a case branch, or undefined
 * (Qodo on PR 337). Judged by the tool's name, as the guard can't know every server's: a merge with no PR number
 * it can read, or a branch it can't read, is refused like one it can tell is a case's.
 */
export function mcpCaseProblem(env: NodeJS.ProcessEnv, tool: string, args: Record<string, unknown>, repo: Reviewed) {
  const records = caseRecords(env);
  if (/merge/i.test(tool)) {
    const number = Number(args.pull_number ?? args.pullNumber ?? args.number ?? args.pr ?? Number.NaN);
    const prs = records?.prs.get(repo.github.toLowerCase()) ?? new Set<number>();
    if (!records || !Number.isInteger(number) || prs.has(number)) return MERGE_REASON;
  }
  if (/(delete|update|move|rename).*(branch|ref)|(branch|ref).*(delete|update|move|rename)/i.test(tool)) {
    const name = String(args.branch ?? args.ref ?? args.name ?? "").replace(/^refs\/heads\//, "");
    if (!records || !name || records.branches.has(name.toLowerCase())) return BRANCH_REASON;
  }
  return undefined;
}

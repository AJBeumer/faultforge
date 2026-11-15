/**
 * Copies of private storage outside it (re-grade 6, Q21). The answer key (`ground-truth.jsonl`), the audit log
 * (`audit-events.jsonl`) and the files of every template still private stay in private storage: none may be copied
 * out by a command, written into another file, or committed in the lab or a reviewed repo. Content is compared by
 * hash, line by line for the two logs and file by file for the templates, so nothing of it is printed, and no copy
 * of it is kept here. A line or file shorter than `MIN_CHARS` is too common to count (`}`, a blank line).
 *
 * The lab's commits are checked at three points: the guard reads what a `git commit` would take before it runs,
 * and the lab's git hooks read the staged files (`lab-pre-commit`) and the message (`lab-commit-msg`) when git
 * makes it, whoever ran it. A private template's id in a lab commit is refused there too.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commitFiles, copyReasons, type Pending, stagedTexts, Uninspectable } from "./guard-content.ts";
import { calls } from "./guard-history.ts";
import { outsidePostedText } from "./guard-posted.ts";
import { privateRoot, privateTemplateIds } from "./guard-private.ts";
import { checkoutAt, LAB_ROOT, locate, within } from "./guard-repos.ts";
import type { Context } from "./guard-tools.ts";
import { pathSteps } from "./shell-paths.ts";

/**
 * `privateCopyTest`, read only when a decision first needs it: most commands never commit or write a file, and
 * reading every private template for each of them would cost the guard's time for nothing.
 */
export function lazyCopyTest(env: NodeJS.ProcessEnv): (text: string) => boolean {
  let test: ((text: string) => boolean) | undefined;
  let read = false;
  return (text) => {
    if (!read) {
      test = privateCopyTest(env);
      read = true;
    }
    return test?.(text) ?? false;
  };
}

/**
 * Why a `git commit` in a checkout that is neither private storage nor a reviewed repo (the lab, a worktree of it)
 * would take a copy of private storage or name a private template, or undefined. Read before the command runs;
 * the lab's pre-commit hook reads the staged files again when git makes the commit.
 */
export function labCommitProblem(ctx: Context, command: string): string | undefined {
  const root = privateRoot(ctx.env);
  for (const call of calls(outsidePostedText(command), ctx.cwd, ctx.backticks)) {
    if (call.program !== "git" || call.args[0] !== "commit" || !call.dir) continue;
    const checkout = checkoutAt(call.dir);
    if (!checkout || within(checkout.root, root) || locate(call.dir, ctx.reviewed)) continue;
    let pending: Pending;
    try {
      pending = labCommit(checkout.root, ctx.names);
    } catch (error) {
      if (!(error instanceof Uninspectable)) throw error;
      return `The guard couldn't read what this commit would take (${error.message}), so it is refused. Commit fewer files at once.`;
    }
    if (pending.reasons.length) {
      return `This commit ${pending.reasons.join(" and ")} (${pending.where}). Remove that first: private content stays in private storage.`;
    }
  }
  return undefined;
}

/** Lines and files shorter than this are too common to count as a copy. */
export const MIN_CHARS = 24;
/** The logs whose every line is private. */
export const PRIVATE_LOGS = ["ground-truth.jsonl", "audit-events.jsonl"];

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const normal = (text: string) => text.replace(/\r\n?/g, "\n").trim();

/** Every file under a folder, recursively. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * A test for text that copies private storage: a whole file of a still-private template, or any line of the
 * answer key or the audit log, each compared by hash. Undefined where there is nothing private to protect.
 */
export function privateCopyTest(env: NodeJS.ProcessEnv, labRoot = LAB_ROOT): ((text: string) => boolean) | undefined {
  const root = privateRoot(env, labRoot);
  const lines = new Set<string>();
  for (const log of PRIVATE_LOGS) {
    const file = join(root, log);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const text = line.trim();
      if (text.length >= MIN_CHARS) lines.add(hash(text));
    }
  }
  const files = new Set<string>();
  for (const id of privateTemplateIds(env, labRoot)) {
    for (const file of filesUnder(join(root, "templates", id))) {
      const text = normal(readFileSync(file, "utf8"));
      if (text.length >= MIN_CHARS) files.add(hash(text));
    }
  }
  if (!lines.size && !files.size) return undefined;
  return (text) => {
    const whole = normal(text);
    if (files.has(hash(whole))) return true;
    return (
      lines.size > 0 &&
      whole.split("\n").some((line) => {
        const trimmed = line.trim();
        return trimmed.length >= MIN_CHARS && lines.has(hash(trimmed));
      })
    );
  };
}

/** The lab's reasons: a private template named in a file or a file's name, or a file that copies private storage. */
function labReasons(names: string[], contents: string[], named: ((text: string) => boolean) | undefined): string[] {
  const found = named?.([...names, ...contents].join("\n")) ? ["names a private template"] : [];
  return [...found, ...copyReasons(contents)];
}

/** What a commit in the lab would take that it may not, read before the command runs (as `pendingCommit`). */
export function labCommit(checkout: string, named: ((text: string) => boolean) | undefined): Pending {
  const { files, contents } = commitFiles(checkout, false);
  return { reasons: labReasons(files, contents, named), where: "the changes not yet committed" };
}

/** What the lab's pre-commit hook refuses in the staged files. */
export function labIndex(checkout: string, named: ((text: string) => boolean) | undefined): Pending {
  const { staged, contents } = stagedTexts(checkout);
  return { reasons: labReasons(staged, contents, named), where: "the staged changes" };
}

/** True when a path is private content: one of the logs, or in a still-private template's folder, or holds one. */
function privatePath(path: string, root: string, ids: string[], recursive: boolean): boolean {
  if (!within(path, root)) return false;
  if (PRIVATE_LOGS.some((log) => within(path, join(root, log)))) return true;
  if (ids.some((id) => within(path, join(root, "templates", id)))) return true;
  // The whole private folder, or its templates folder, copied with everything in it.
  return recursive && (within(join(root, "templates"), path) || within(root, path));
}

/** Programs that copy what they name to their last word. */
const COPIERS = /^(cp|copy|copy-item|cpi|mv|move|move-item|mi|install|rsync|scp|xcopy|robocopy|ln|mklink)$/;
/** Programs that print a file, whose output a redirect or `tee` could write elsewhere. */
const PRINTERS = /^(cat|type|get-content|gc|head|tail|less|more|tac|nl|sort|uniq|cut|awk|sed|grep|rg|findstr)$/;

export const COPY_OUT =
  "This would copy the answer key, the audit log or a private template out of private storage. Nothing there leaves it.";

/** Why a shell command copies private content out of private storage, or undefined (Q21). */
export function copyOutProblem(command: string, cwd: string, env: NodeJS.ProcessEnv, backticks = true) {
  const root = privateRoot(env);
  const ids = privateTemplateIds(env);
  const outside = (path: string) => !within(path, root);
  for (const step of pathSteps(command, cwd, backticks)) {
    const recursive = step.args.some((w) => /^(-[a-z]*[rRa][a-z]*|--recursive|--archive|-recurse|\/s|\/e)$/i.test(w));
    if (COPIERS.test(step.name)) {
      const words = step.perWord.filter((list) => list.length);
      const destination = words.at(-1) ?? [];
      const sources = words.slice(0, -1).flat();
      if (sources.some((s) => privatePath(s, root, ids, recursive)) && destination.some(outside)) return COPY_OUT;
    }
    const printed = PRINTERS.test(step.name) && step.paths.some((p) => privatePath(p, root, ids, false));
    if (printed && step.redirects.some(outside)) return COPY_OUT;
  }
  // A printed file piped into `tee` or a redirect in a later step.
  const all = pathSteps(command, cwd, backticks);
  const reads = all.some((s) => PRINTERS.test(s.name) && s.paths.some((p) => privatePath(p, root, ids, false)));
  const writes = all.some(
    (s) => (s.name === "tee" && s.paths.some(outside)) || (s !== all[0] && s.redirects.some(outside)),
  );
  return reads && writes ? COPY_OUT : undefined;
}

/** Why a Write or Edit of `path` with `text` copies private content out of private storage, or undefined. */
export function copyOutEdit(path: string, text: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!text || within(path, privateRoot(env))) return undefined;
  return privateCopyTest(env)?.(text) ? COPY_OUT : undefined;
}

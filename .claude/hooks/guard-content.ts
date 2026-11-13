/**
 * What the guard reads from git before a commit or a push: the content about to leave a reviewed
 * checkout. Shell text can't show what a redirect, a copy or a script wrote, so this module ignores the
 * command and asks git for the pending state. Used by guard-target.ts.
 */
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { telltales } from "../../packages/harness/src/neutral.ts";

/** Thrown when git can't answer for a checkout, or can't answer in time: the caller fails closed. */
export class Uninspectable extends Error {}

export interface Pending {
  /** Telltale reasons found in the pending content, or an empty list. */
  reasons: string[];
  /** Where they were found, for the denial message. */
  where: string;
}

/** Too much pending content to read within the hook's time limit: fail closed rather than skim. */
const MAX_FILES = 500;
const MAX_COMMITS = 50;
/** The hook has 15 s in settings.json; the scan gives up well before that, so a timeout can't let the tool run. */
const DEFAULT_BUDGET_MS = 8000;

function run(checkout: string, args: string[], input?: string): Buffer {
  const result = spawnSync("git", ["-C", checkout, ...args], { input, timeout: 10_000, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    const detail = (result.stderr?.toString() || result.error?.message || "").trim().split("\n")[0];
    throw new Uninspectable(`git ${args[0]} failed: ${detail}`);
  }
  return result.stdout;
}

function git(checkout: string, args: string[]): string {
  return run(checkout, args).toString("utf8");
}

/** NUL-separated output as a list, so quoted or escaped file names come back as written. */
function list(checkout: string, args: string[]): string[] {
  return git(checkout, [...args, "-z"])
    .split("\0")
    .filter(Boolean);
}

/**
 * The contents of several git objects in one process (`git cat-file --batch`), each named as `rev:path`
 * or `:0:path`. Binary content is decoded as text, so an ASCII telltale in it still shows. A missing
 * object is a failure to inspect.
 */
function blobs(checkout: string, specs: string[]): string[] {
  if (!specs.length) return [];
  const out = run(checkout, ["cat-file", "--batch"], `${specs.join("\n")}\n`);
  const contents: string[] = [];
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(10, at);
    if (end < 0) break;
    const header = out.subarray(at, end).toString("utf8").split(" ");
    at = end + 1;
    const size = Number(header[2]);
    if (header[1] === "missing" || header.length < 3 || !Number.isFinite(size)) {
      throw new Uninspectable(`object ${header[0]} could not be read`);
    }
    contents.push(out.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  if (contents.length !== specs.length) throw new Uninspectable("cat-file returned fewer objects than asked");
  return contents;
}

/**
 * What a path in the working tree would put in a commit: a file's bytes as text, a symlink's target text
 * (which is what git stores), nothing for a folder or a path that is gone (its index copy is read instead).
 */
function worktreeText(path: string): string {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return readlinkSync(path);
    return stat.isFile() ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

const unique = (items: string[]) => [...new Set(items)];

/**
 * The telltales in what a commit would take from `checkout`: every tracked file changed in the working tree
 * or staged (`-a` commits both; a file staged and then deleted from the working tree still commits its
 * staged copy), read from the working tree and from the index; every untracked file (a chained `git add`
 * would stage it); and every ignored file when `forceIgnored` is set (`git add -f`). File names count too.
 */
export function pendingCommit(checkout: string, forceIgnored: boolean): Pending {
  const tracked = unique([
    ...list(checkout, ["diff", "HEAD", "--name-only", "--diff-filter=d"]),
    ...list(checkout, ["diff", "--cached", "--name-only", "--diff-filter=d"]),
  ]);
  const untracked = list(checkout, ["ls-files", "--others", "--exclude-standard"]);
  const ignored = forceIgnored ? list(checkout, ["ls-files", "--others", "--ignored", "--exclude-standard"]) : [];
  const files = unique([...tracked, ...untracked, ...ignored]);
  if (files.length > MAX_FILES) throw new Uninspectable(`${files.length} pending files, more than the guard reads`);
  const texts = [
    ...files,
    ...files.map((file) => worktreeText(join(checkout, file))),
    ...blobs(
      checkout,
      tracked.map((file) => `:0:${file}`),
    ),
  ];
  return { reasons: telltales(texts.join("\n")), where: "the changes not yet committed" };
}

/**
 * The telltales in what a push could take from `checkout`: every local commit not yet on any remote
 * branch, whichever branch or tag the push names, commit by commit (a later commit removing a line does
 * not clean an earlier one): each commit's message, and the full content and name of every file it adds
 * or changes, merge commits included (`-m`: against each parent). Gives up, as a failure to inspect, when
 * the work exceeds `budgetMs`, so a slow scan can never run past the hook's own time limit.
 */
export function pendingPush(checkout: string, budgetMs = DEFAULT_BUDGET_MS): Pending {
  const started = Date.now();
  const tick = () => {
    if (Date.now() - started > budgetMs) {
      throw new Uninspectable(
        `reading the unpushed commits took longer than the ${budgetMs} ms the guard allows; push in smaller steps`,
      );
    }
  };
  const commits = git(checkout, ["rev-list", "--all", "--not", "--remotes"]).split("\n").filter(Boolean);
  if (commits.length > MAX_COMMITS)
    throw new Uninspectable(`${commits.length} unpushed commits, more than the guard reads`);
  const texts: string[] = [];
  for (const sha of commits) {
    tick();
    texts.push(git(checkout, ["log", "-1", "--format=%B", sha]));
    const files = unique(
      list(checkout, ["diff-tree", "--no-commit-id", "-m", "-r", "--name-only", "--diff-filter=d", "--root", sha]),
    );
    if (files.length > MAX_FILES)
      throw new Uninspectable(`commit ${sha.slice(0, 7)} touches ${files.length} files, more than the guard reads`);
    texts.push(
      ...files,
      ...blobs(
        checkout,
        files.map((file) => `${sha}:${file}`),
      ),
    );
  }
  tick();
  // A push can also create a branch or tag whose name the reviewer sees: every local branch and tag with no
  // remote branch of the same name is read too (#190). A branch already on a remote was checked when it went.
  const refs = (...args: string[]) =>
    git(checkout, ["for-each-ref", ...args])
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);
  // Every local branch and tag name is read, pushed or not: a push can send a branch to a remote that doesn't
  // have it yet, and without asking the remotes the guard can't tell which (Qodo on PR 208). A giveaway name
  // shouldn't stay on the target either way, so this blocks pushes until it is removed.
  const giveaways = refs("--format=%(refname:lstrip=2)", "refs/heads", "refs/tags").filter(
    (name) => telltales(name).length,
  );
  const reasons = [...new Set([...telltales(texts.join("\n")), ...giveaways.flatMap((name) => telltales(name))])];
  const where = giveaways.length
    ? `a new branch, or a tag (${giveaways.join(", ")})`
    : `the ${commits.length} commit${commits.length === 1 ? "" : "s"} not yet on any remote branch`;
  return { reasons, where };
}

/** The command with quoted text and heredoc bodies blanked, so operators inside them don't count. */
export function blankQuoted(command: string): string {
  return command
    .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(\n|$)/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (quoted) => (/^"[\s\S]*(\$\(|`)/.test(quoted) ? quoted : " "));
}

/**
 * The steps allowed in one command together with a git step inside a reviewed checkout: moving around,
 * git steps that don't write files from outside git's own history (with `-C` and the other path options
 * allowed in front), the GitHub CLI, npm scripts, and a few harmless words. Anything else (a copy, a
 * redirect, a script, a shell function) could put content in the checkout after the guard looked, so it
 * must run as its own command first.
 */
const GIT_OPTIONS = String.raw`(?:(?:-C\s*\S*|--work-tree[=\s]*\S*|--git-dir[=\s]*\S*)\s*)*`;
const ALLOWED_STEP = new RegExp(
  String.raw`^(?:(?:cd|pushd|popd|Set-Location|sl|echo|true|exit|sleep)\b|git\s+${GIT_OPTIONS}(?:add|rm|mv|commit|push|pull|fetch|status|diff|log|rev-parse|branch|switch|checkout|merge|remote|show|tag|restore)\b|gh\s|npm\s)`,
  "i",
);

/**
 * Why a chained command that mentions git may not run inside a reviewed checkout, or undefined. The guard
 * checks the checkout's content before the command runs, so every step of a chain that commits or pushes
 * must be one that can't change that content behind its back: no writing step, no hidden command, no
 * redirect other than to `/dev/null` or a descriptor, and no heredoc body that expands `$(…)`.
 */
export function chainProblem(command: string): string | undefined {
  // An unquoted heredoc delimiter means the body expands: a `$(…)` or backtick in it runs a command,
  // unless the shell escape `\$(` or `` \` `` keeps it literal. An escaped backslash (`\\`) is removed
  // first, so `\\$(…)` is seen for what the shell makes of it: a literal backslash and a real substitution.
  for (const m of command.matchAll(/<<-?\s*(["']?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*(?:\n|$)/g)) {
    const body = (m[3] ?? "").replace(/\\\\/g, "").replace(/\\\$\(|\\`/g, "");
    if (!m[1] && /\$\(|`/.test(body)) return "a heredoc body that runs $(…)";
  }
  const steps = blankQuoted(command)
    .split(/;|&&|\|\||\||\n|(?<![&>])&(?![&>])/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const step of steps) {
    // A substitution runs whatever is inside it, whatever the step around it is allowed to do.
    if (/\$\(|`/.test(step)) return step;
    const harmless = step.replace(/\d*>&\d+/g, "").replace(/\d*>\s*\/dev\/null/g, "");
    if (/>/.test(harmless) || !ALLOWED_STEP.test(step)) return step;
  }
  return undefined;
}

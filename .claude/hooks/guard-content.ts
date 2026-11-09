/**
 * What the guard reads from git before a commit or a push: the content about to leave a reviewed
 * checkout. Shell text can't show what a redirect, a copy or a script wrote, so this module ignores the
 * command and asks git for the pending state. Used by guard-target.ts.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { telltales } from "../../packages/harness/src/neutral.ts";

/** Thrown when git can't answer for a checkout: the caller fails closed. */
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

function git(checkout: string, args: string[]): string {
  const result = spawnSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim().split("\n")[0];
    throw new Uninspectable(`git ${args[0]} failed: ${detail}`);
  }
  return result.stdout;
}

/** NUL-separated output as a list, so quoted or escaped file names come back as written. */
function list(checkout: string, args: string[]): string[] {
  return git(checkout, [...args, "-z"])
    .split("\0")
    .filter(Boolean);
}

/** A file's bytes as text; a binary file still shows any ASCII telltale it carries. */
function fileText(path: string): string {
  return statSync(path).isFile() ? readFileSync(path, "utf8") : "";
}

/**
 * The telltales in what a commit would take from `checkout`: every tracked file with staged or unstaged
 * changes (`-a` commits both), read from the working tree and from the index, every untracked file (a
 * chained `git add` would stage it), and every ignored file when `forceIgnored` is set (`git add -f`).
 * File names count too.
 */
export function pendingCommit(checkout: string, forceIgnored: boolean): Pending {
  const changed = list(checkout, ["diff", "HEAD", "--name-only", "--diff-filter=d"]);
  const untracked = list(checkout, ["ls-files", "--others", "--exclude-standard"]);
  const ignored = forceIgnored ? list(checkout, ["ls-files", "--others", "--ignored", "--exclude-standard"]) : [];
  const files = [...changed, ...untracked, ...ignored];
  if (files.length > MAX_FILES) throw new Uninspectable(`${files.length} pending files, more than the guard reads`);
  const texts = [
    ...files,
    ...files.map((file) => fileText(join(checkout, file))),
    ...changed.map((file) => git(checkout, ["show", `:0:${file}`])),
  ];
  return { reasons: telltales(texts.join("\n")), where: "the changes not yet committed" };
}

/**
 * The telltales in what a push could take from `checkout`: every local commit not yet on any remote
 * branch, whichever branch or tag the push names, commit by commit (a later commit removing a line does
 * not clean an earlier one): each commit's message, and the full content and name of every file it adds
 * or changes.
 */
export function pendingPush(checkout: string): Pending {
  const commits = git(checkout, ["rev-list", "--all", "--not", "--remotes"]).split("\n").filter(Boolean);
  if (commits.length > MAX_COMMITS)
    throw new Uninspectable(`${commits.length} unpushed commits, more than the guard reads`);
  const texts: string[] = [];
  for (const sha of commits) {
    texts.push(git(checkout, ["log", "-1", "--format=%B", sha]));
    const files = list(checkout, [
      "diff-tree",
      "--no-commit-id",
      "-r",
      "--name-only",
      "--diff-filter=d",
      "--root",
      sha,
    ]);
    if (files.length > MAX_FILES)
      throw new Uninspectable(`commit ${sha.slice(0, 7)} touches ${files.length} files, more than the guard reads`);
    texts.push(...files, ...files.map((file) => git(checkout, ["show", `${sha}:${file}`])));
  }
  const where = `the ${commits.length} commit${commits.length === 1 ? "" : "s"} not yet on any remote branch`;
  return { reasons: telltales(texts.join("\n")), where };
}

/** The command with quoted text and heredoc bodies blanked, so operators inside them don't count. */
export function blankQuoted(command: string): string {
  return command
    .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(\n|$)/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (quoted) => (/^"[\s\S]*(\$\(|`)/.test(quoted) ? quoted : " "));
}

/**
 * The steps allowed in one command together with a git step inside a reviewed checkout: moving around,
 * git steps that don't write files from outside git's own history, the GitHub CLI, npm scripts, and a few
 * harmless words. Anything else (a copy, a redirect, a script, a shell function) could put content in the
 * checkout after the guard looked, so it must run as its own command first.
 */
const ALLOWED_STEP =
  /^(?:(?:cd|pushd|popd|Set-Location|sl|echo|true|exit|sleep)\b|git\s+(?:add|rm|mv|commit|push|pull|fetch|status|diff|log|rev-parse|branch|switch|checkout|merge|remote|show|tag|restore)\b|gh\s|npm\s)/i;

/**
 * Why a chained command that mentions git may not run inside a reviewed checkout, or undefined. The guard
 * checks the checkout's content before the command runs, so every step of a chain that commits or pushes
 * must be one that can't change that content behind its back.
 */
export function chainProblem(command: string): string | undefined {
  const steps = blankQuoted(command)
    .split(/;|&&|\|\||\||\n|(?<![&>])&(?![&>])/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const step of steps) {
    const redirects = /(?<![0-9&])>(?!&)/.test(step.replace(/\s2>&1|>\s*\/dev\/null/g, ""));
    if (!ALLOWED_STEP.test(step) || redirects) return step;
  }
  return undefined;
}

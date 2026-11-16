/**
 * The git-level guard can't be switched off (re-grade 6, N-B). Git runs the guard's hooks for every commit and
 * push, whoever starts them, so long as the hooks are in place and their setting names the guard: a command that
 * changes either would leave every later commit and push unchecked. Refused in any checkout, from the shell or
 * the file tools:
 *  - setting, unsetting or removing `review-guard.*`, `core.hooksPath`, a URL rewrite (`insteadOf`) or an
 *    included config file, by `git config`, `git -c`, or git's config variables (`GIT_CONFIG_*`);
 *  - any change to a file in a `.git` folder by a program other than git: named, matched by a wildcard that could
 *    name it (`.g*`), reached through a link, or after a move into one (`cd .git; rm hooks/x`); and by Write or Edit.
 * Reading them stays allowed: `git config --get`, `cat`, `ls`, `grep`. Words in a commit message or a post body
 * are words, not settings. A step that runs a substitution never counts as a read: the substitution may write.
 * Split from guard-target.ts, which may not pass 400 lines.
 */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { existingFolder } from "../shared/repos.ts";
import { spokenWords } from "../shell/decode.ts";
import { hasWildcard } from "../shell/glob.ts";
import { outsidePostedText } from "../shell/posted.ts";
import { blankQuoted } from "../shell/scan.ts";
import { programAt, programName, steps, unquote, words } from "../shell/words.ts";

/** Settings that decide whether git runs the guard's hooks, or where a remote really goes. */
const GUARD_SETTINGS =
  /\bcore\.hookspath\b|\breview-guard\b|\b(?:push)?insteadof\b|\binclude(?:if)?\.|\bGIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|SYSTEM)\b/i;

/** A path into a git folder: `.git` as a path segment, however it ends, or git's own ways to name its folder. */
const GIT_FOLDER = /(?:^|[\s"'=/\\;&|(<>])\.git(?![\w.-])|--git-(?:path|common-dir|dir)\b|\bGIT_(?:DIR|COMMON_DIR)\b/i;

/** Programs that only read or move between folders. A redirect makes any of them a write; that is read apart. */
const READERS =
  /^(cat|ls|dir|head|tail|type|get-content|gc|get-childitem|gci|get-item|gi|stat|file|wc|grep|egrep|fgrep|rg|findstr|select-string|sls|less|more|echo|printf|write-output|test|\[|diff|cmp|sha1sum|sha256sum|md5sum|test-path|cd|pushd|popd|set-location|sl|pwd|true|find)$/;

/** Programs that move into a folder. */
const MOVES = /^(cd|pushd|chdir|set-location|sl)$/;

/** Git commands that only read. */
const GIT_READS =
  /^(log|show|status|diff|grep|rev-parse|ls-files|ls-tree|cat-file|describe|blame|shortlog|help|version|var)$/;

/** Redirects that write no file: to another descriptor or to the null device. */
const HARMLESS_REDIRECT = /\d?>&\d|\d?>\s*\/dev\/null|\d?>\s*nul\b/gi;

/**
 * True when a `git config` call only reads: a `--get…`, `--list` or `-l` option anywhere, or the newer `get` and
 * `list` subcommands as its first word. A bare `get` later on is a value (`core.hooksPath get`; Qodo on PR 333).
 */
export function configReads(args: string[]): boolean {
  return /^(get|list)$/.test(args[0] ?? "") || args.some((w) => /^(--get(-all|-regexp|-urlmatch)?|--list|-l)$/.test(w));
}

/** The program and its words of one step, quotes removed. */
function parse(text: string): { name: string; rest: string[] } {
  const all = words(text).map(unquote);
  const { at } = programAt(all);
  return { name: programName(all[at] ?? ""), rest: all.slice(at + 1) };
}

/** True when one step only reads: a reading program, or git reading, with no redirect into a file or substitution. */
function stepReads(text: string, backticks: boolean): boolean {
  if (/>/.test(blankQuoted(text).replace(HARMLESS_REDIRECT, " "))) return false;
  if (/\$\(|<\(|>\(/.test(text) || (backticks && text.includes("`"))) return false;
  const { name, rest } = parse(text);
  if (name === "find") return !rest.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(w));
  if (name !== "git") return READERS.test(name);
  let i = 0;
  while (i < rest.length && (rest[i] ?? "").startsWith("-")) i += /^-[Cc]$/.test(rest[i] ?? "") ? 2 : 1;
  const sub = rest[i] ?? "";
  if (sub === "config") return configReads(rest.slice(i + 1));
  return GIT_READS.test(sub);
}

/** True when every step of the command only reads. */
export function onlyReads(command: string, backticks: boolean): boolean {
  return steps(command, backticks).every((step) => stepReads(step.text, backticks));
}

/** True when a path, where it really leads (through a link to a file or a folder), is in a `.git` folder. */
function inGitFolder(path: string): boolean {
  const full = resolve(path);
  const places = [full];
  try {
    const folder = existingFolder(full);
    places.push(join(realpathSync.native(folder), relative(folder, full)));
    if (lstatSync(full, { throwIfNoEntry: false })) places.push(realpathSync.native(full));
  } catch {
    // the path as written
  }
  return places.some((p) => /(^|[/\\])\.git([/\\]|$)/i.test(p));
}

/**
 * True when a shell word names a link, or a path under a linked folder, that leads into a `.git` folder. Only
 * links are followed, at two `lstat` calls a word, so a long command stays fast.
 */
function linkIntoGit(path: string): boolean {
  const linked = [path, dirname(path)].some((p) => {
    try {
      return lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
    } catch {
      return false;
    }
  });
  return linked && inGitFolder(path);
}

/** True when a word's wildcard could name a `.git` folder: one of its segments matches `.git` as a glob. */
function wildcardGit(word: string, backticks: boolean): boolean {
  if (!hasWildcard(word)) return false;
  return word.split(/[/\\]+/).some((segment) => {
    // Bash's wildcards skip names that start with a dot unless the pattern starts with one (Qodo on PR 333);
    // PowerShell's don't (`[.]git`).
    if (!hasWildcard(segment) || (backticks && !/^[.{]/.test(segment))) return false;
    const pattern = segment
      .replace(/[.+^$()|\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
      .replace(/\{([^}]*)\}/g, (_m, inner: string) => `(?:${inner.split(",").join("|")})`);
    try {
      return new RegExp(`^${pattern}$`, "i").test(".git");
    } catch {
      return true;
    }
  });
}

/**
 * Why the command could switch off the git-level guard, or undefined: a step that does more than read names one
 * of its settings, or (a program other than git) reaches a file in a git folder, by name, by a wildcard, through a
 * link from `cwd`, or after the command or the folder it runs in moved into one.
 */
export function guardSwitchOff(command: string, backticks = true, cwd?: string): string | undefined {
  const outside = outsidePostedText(command);
  let inside = cwd !== undefined && inGitFolder(cwd);
  for (const step of steps(outside, backticks)) {
    // As written too: to PowerShell a backslash is a path's separator, not an escape (`.git\hooks`).
    const texts = [step.text, spokenWords(step.text)];
    const { name, rest } = parse(step.text);
    const folder = name !== "git" && texts.some((t) => GIT_FOLDER.test(t));
    if (MOVES.test(name) && folder) inside = true;
    if (stepReads(step.text, backticks)) continue;
    if (texts.some((t) => GUARD_SETTINGS.test(t))) return SWITCH_OFF;
    if (name === "git") continue;
    const paths = rest.map((w) => w.replace(/^\d*[<>]+/, "")).filter((w) => w && !w.startsWith("-"));
    const linked = cwd !== undefined && paths.some((w) => !/[$`%]/.test(w) && linkIntoGit(resolve(cwd, w)));
    // A wildcard is read as the shell joins its quoted parts: `.g''*` is `.g*` (Qodo on PR 333).
    const globbed = paths.some((w) => wildcardGit(w.replace(/["'`]/g, ""), backticks));
    if (inside || folder || linked || globbed) return SWITCH_OFF;
  }
  return undefined;
}

const SWITCH_OFF =
  "This would change what git runs on a commit or push (the guard's hooks, review-guard.*, core.hooksPath, a URL rewrite, or a file in a .git folder), which would switch off the git-level guard. Only `npm run guard:install` sets these; read them with git config --get, cat or ls.";

/** Why a file edit is refused because it changes a file in a git folder (re-grade 6), or undefined. */
export function gitFolderEdit(path: string): string | undefined {
  if (!inGitFolder(path)) return undefined;
  return "This edit would change a file in a .git folder (its hooks or config decide what git runs), which could switch off the git-level guard. Only `npm run guard:install` writes there.";
}

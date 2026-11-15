/**
 * The git-level guard can't be switched off (re-grade 6, N-B). Git runs the guard's hooks for every commit and
 * push, whoever starts them, so long as the hooks are in place and their setting names the guard: a command that
 * changes either would leave every later commit and push unchecked. Refused in any checkout, from the shell or
 * the file tools:
 *  - setting, unsetting or removing `review-guard.*`, `core.hooksPath`, a URL rewrite (`insteadOf`) or an
 *    included config file, by `git config`, `git -c`, or git's config variables (`GIT_CONFIG_*`);
 *  - any change to a file in a `.git` folder (its hooks, its config) by a shell command, or by Write or Edit.
 * Reading them stays allowed: `git config --get`, `cat`, `ls`, `grep`. Words in a commit message or a post body
 * are words, not settings. Split from guard-target.ts, which may not pass 400 lines.
 */
import { realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { outsidePostedText } from "./guard-posted.ts";
import { existingFolder } from "./guard-repos.ts";
import { spokenWords } from "./shell-decode.ts";
import { blankQuoted } from "./shell-scan.ts";
import { programAt, programName, steps, words } from "./shell-words.ts";

/** Settings that decide whether git runs the guard's hooks, or where a remote really goes. */
const GUARD_SETTINGS =
  /\bcore\.hookspath\b|\breview-guard\b|\b(?:push)?insteadof\b|\binclude(?:if)?\.|\bGIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|SYSTEM)\b/i;

/** A path into a git folder: `.git` as a path segment, or git's own ways to name its folder. */
const GIT_FOLDER = /(?:^|[\s"'=/\\])\.git(?=[/\\\s"']|$)|--git-(?:path|common-dir|dir)\b|\bGIT_(?:DIR|COMMON_DIR)\b/i;

/** The files in a git folder that decide what runs: its hooks and its config. */
const GUARD_FILES = /\bhooks?\b|\bconfig\b/i;

/** Programs that only read or move between folders. A redirect makes any of them a write; that is read apart. */
const READERS =
  /^(cat|ls|dir|head|tail|type|get-content|gc|get-childitem|gci|get-item|gi|stat|file|wc|grep|egrep|fgrep|rg|findstr|select-string|sls|less|more|echo|printf|write-output|test|\[|diff|cmp|sha1sum|sha256sum|md5sum|test-path|cd|pushd|popd|set-location|sl|pwd|true|find)$/;

/** Git commands that only read. */
const GIT_READS =
  /^(log|show|status|diff|grep|rev-parse|ls-files|ls-tree|cat-file|describe|blame|shortlog|help|version|var)$/;

/** `git config` options that only read. */
const CONFIG_READS = /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|get|list)$/;

/** Redirects that write no file: to another descriptor or to the null device. */
const HARMLESS_REDIRECT = /\d?>&\d|\d?>\s*\/dev\/null|\d?>\s*nul\b/gi;

const unquote = (word: string) => word.replace(/^'([^']*)'$/s, "$1").replace(/^"(.*)"$/s, "$1");

/** True when every step of the command only reads: no redirect into a file, and only reading programs. */
export function onlyReads(command: string, backticks: boolean): boolean {
  if (/>/.test(blankQuoted(command).replace(HARMLESS_REDIRECT, " "))) return false;
  return steps(command, backticks).every((step) => {
    const all = words(step.text).map(unquote);
    const { at } = programAt(all);
    const name = programName(all[at] ?? "");
    const rest = all.slice(at + 1);
    if (name === "find") return !rest.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(w));
    if (name !== "git") return READERS.test(name);
    let i = 0;
    while (i < rest.length && (rest[i] ?? "").startsWith("-")) i += /^-[Cc]$/.test(rest[i] ?? "") ? 2 : 1;
    const sub = rest[i] ?? "";
    if (sub === "config") return rest.slice(i + 1).some((w) => CONFIG_READS.test(w));
    return GIT_READS.test(sub);
  });
}

/**
 * Why the command could switch off the git-level guard, or undefined: it names one of its settings, or a file in
 * a git folder that decides what runs, outside posted text, and does more than read.
 */
export function guardSwitchOff(command: string, backticks = true): string | undefined {
  const outside = outsidePostedText(command);
  // As written too: to PowerShell a backslash is a path's separator, not an escape (`.git\hooks`).
  const touches = [outside, spokenWords(outside)].some(
    (text) => GUARD_SETTINGS.test(text) || (GIT_FOLDER.test(text) && GUARD_FILES.test(text)),
  );
  if (!touches || onlyReads(outside, backticks)) return undefined;
  return "This would change what git runs on a commit or push (the guard's hooks, review-guard.*, core.hooksPath, a URL rewrite, or a file in a .git folder), which would switch off the git-level guard. Only `npm run guard:install` sets these; read them with git config --get, cat or ls.";
}

/** Why a file edit is refused because it changes a file in a git folder (re-grade 6), or undefined. */
export function gitFolderEdit(path: string): string | undefined {
  const full = resolve(path);
  let real = full;
  try {
    const folder = existingFolder(full);
    real = join(realpathSync.native(folder), relative(folder, full));
  } catch {
    // the path as written
  }
  if (![full, real].some((p) => /(^|[/\\])\.git([/\\]|$)/i.test(p))) return undefined;
  return "This edit would change a file in a .git folder (its hooks or config decide what git runs), which could switch off the git-level guard. Only `npm run guard:install` writes there.";
}

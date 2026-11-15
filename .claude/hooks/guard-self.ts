/**
 * The guard's own code, in the checkout it runs from (re-grade 6, H12, H14, H18). The hooks Claude Code and git run
 * are the files in that checkout: `.claude/hooks/**`, the settings that register them (`.claude/settings.json`,
 * `.claude/settings.local.json`) and the word list they import (`packages/harness/src/neutral.ts`). An owner
 * session that rewrote one of them, emptied it or deleted it would switch the guard off for every later command,
 * git's commits and pushes included. So no shell command and no Write or Edit changes them there.
 *
 * The owner changes the guard through a normal PR, from a worktree or a clone: only the checkout the guard runs from
 * is held. For the rare change made in that checkout itself, the owner unlocks it by hand: an empty file named
 * `faultforge-guard-unlock` in its git folder (`.git/`), deleted again afterwards. Why a file, and not "allowed off
 * main": a session can switch branches itself (`git switch -c x`), and the edited guard would then run at once. The
 * unlock file sits in the git folder, which no program but git may write (guard-hooks.ts), and no command may name
 * it, so the session can't make it; only the owner can, outside it.
 *
 * Refused while locked:
 *  - a program that writes, deletes or moves files (`rm`, `mv`, `tee`, `sed -i`, `Remove-Item`, …) naming one of
 *    them, a folder they are in, or a wildcard or brace list that matches one; a copy or link whose destination is
 *    one, or a folder that would take one (`cp -r x/.claude .`); a redirect into one;
 *  - `git checkout`, `restore`, `rm` and `mv` of one of them (`git checkout HEAD~3 -- .claude/hooks`);
 *  - inline interpreter code that names them (`node -e "fs.writeFileSync('.claude/hooks/…')"`);
 *  - a Write or Edit of one of them.
 * Refused always: any command that does more than read and names the unlock file.
 * A script file can still write anything the session can: that is the limit of reading commands, as elsewhere.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { onlyReads } from "./guard-hooks.ts";
import { outsidePostedText } from "./guard-posted.ts";
import { existingFolder, LAB_ROOT } from "./guard-repos.ts";
import { braces } from "./shell-glob.ts";
import { interpreterPipelines } from "./shell-interp.ts";
import { type PathStep, pathSteps } from "./shell-paths.ts";
import { joinedWords } from "./shell-scan.ts";
import { steps, unquote, words } from "./shell-words.ts";

/** The unlock file's name, in the git folder of the checkout the guard runs from. */
export const UNLOCK_FILE = "faultforge-guard-unlock";
/** Any spelling a command could build the name from. */
const UNLOCK_STEM = /guard[\W_]*unlock/i;

/** The guard's own files, relative to its checkout, with `/` and in lower case: a folder ends in `/`. */
export const OWN_FILES = [
  ".claude/hooks/",
  ".claude/settings.json",
  ".claude/settings.local.json",
  "packages/harness/src/neutral.ts",
];

/** Programs that write, delete, move or change the mode of the files they name. */
const WRITERS =
  /^(rm|rmdir|unlink|shred|touch|truncate|tee|mv|dd|chmod|chown|chattr|patch|del|erase|rd|move|ren|rename|remove-item|ri|move-item|mi|rename-item|rni|set-content|sc|add-content|ac|out-file|new-item|ni|clear-content|clc|set-item|si)$/;
/** Programs whose last word is where they write: everything before it is only read. */
const COPIERS = /^(cp|copy|copy-item|cpi|install|rsync|ln|mklink|xcopy|robocopy)$/;
/** Editors that write in place only with `-i`. */
const IN_PLACE = /^(sed|perl|ruby)$/;
/** Git commands that write the named files in the working tree. */
const GIT_WRITES = /^(checkout|restore|rm|mv)$/;

/** The checkouts whose guard files are held: the one this guard runs from, and one a test names. */
export function guardRoots(env: NodeJS.ProcessEnv): string[] {
  return [LAB_ROOT, ...(env.FAULTFORGE_GUARD_ROOT ? [resolve(env.FAULTFORGE_GUARD_ROOT)] : [])];
}

/** The git folder of a checkout: `.git` itself, or where a worktree's `.git` file points. */
function gitFolder(root: string): string {
  const dotGit = join(root, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim() ?? "";
    return isAbsolute(pointer) ? pointer : resolve(root, pointer);
  } catch {
    return dotGit;
  }
}

/** True when the owner has unlocked the checkout's guard files by hand. */
export function unlocked(root: string): boolean {
  return existsSync(join(gitFolder(root), UNLOCK_FILE));
}

const fold = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);

/** Where a path really leads: as written, and through a link in a folder on the way. */
function places(path: string): string[] {
  const out = [path];
  try {
    const folder = existingFolder(path);
    out.push(join(realpathSync.native(folder), relative(folder, path)));
  } catch {
    // the path as written
  }
  return out;
}

/** How a path relates to the guard's files in `root`: one of them (or in one), a folder holding one, or neither. */
export function relation(path: string, root: string): "own" | "holds" | undefined {
  let found: "own" | "holds" | undefined;
  for (const place of places(path)) {
    const rel = fold(relative(root, place).replace(/\\/g, "/"));
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    if (OWN_FILES.some((own) => (own.endsWith("/") ? `${rel}/`.startsWith(own) : rel === own))) return "own";
    if (rel === "" || OWN_FILES.some((own) => own.startsWith(`${rel}/`))) found = "holds";
  }
  return found;
}

/** The deny reason for a change to the guard's own files. */
export const SELF_EDIT = `This would change the guard's own files (.claude/hooks, .claude/settings*.json or neutral.ts) in the checkout it runs from, which would switch it off. Change them through a PR from a worktree; for a change in this checkout the owner unlocks it by hand (${UNLOCK_FILE} in its git folder).`;

const UNLOCK_NAMED =
  "This names the guard's unlock file. Only the owner makes or removes it, by hand, outside a session.";

/** Why a Write or Edit of `path` is refused, or undefined. */
export function selfFileEdit(path: string, env: NodeJS.ProcessEnv): string | undefined {
  if (UNLOCK_STEM.test(basename(path))) return UNLOCK_NAMED;
  const held = guardRoots(env).filter((root) => !unlocked(root));
  return held.some((root) => relation(path, root) === "own") ? SELF_EDIT : undefined;
}

/** True when the step writes one of the guard's files in a held checkout. */
function stepWrites(step: PathStep, held: string[], command: string): boolean {
  const own = (path: string) => held.some((root) => relation(path, root) === "own");
  const touches = (path: string) => held.some((root) => relation(path, root) !== undefined);
  if (step.redirects.some(own)) return true;
  const recursive = step.args.some((w) => /^(-[a-z]*[rRa][a-z]*|--recursive|--archive|-recurse|\/s|\/e)$/i.test(w));
  let writer = WRITERS.test(step.name) || (IN_PLACE.test(step.name) && step.args.some((w) => /^-[a-z]*i/.test(w)));
  if (step.name === "git") {
    const sub = step.args.find((w) => !w.startsWith("-")) ?? "";
    writer = GIT_WRITES.test(sub);
  }
  if (COPIERS.test(step.name)) {
    const words = step.perWord.filter((list) => list.length);
    const destination = words.at(-1) ?? [];
    const sources = words.slice(0, -1).flat();
    const landing = destination.flatMap((d) => [d, ...sources.map((s) => join(d, basename(s)))]);
    if (landing.some(own)) return true;
    if (recursive && landing.some(touches)) return true;
  }
  if (!writer) return false;
  if (step.paths.some(touches)) return true;
  // A word the guard can't read could be one of them, when the command names them anywhere.
  return step.unknown && /\.claude|neutral\.ts/i.test(command);
}

/** Why a shell command is refused because it changes the guard's own files or names the unlock file, or undefined. */
export function selfShellProblem(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  backticks = true,
): string | undefined {
  // The unlock file, in any spelling a brace list could build, by any command that does more than read. Words in a
  // commit message or a post body name no file.
  for (const step of steps(outsidePostedText(command), backticks)) {
    if (onlyReads(step.text, backticks)) continue;
    const spelled = words(step.text)
      .map(unquote)
      .flatMap((word) => braces(word) ?? [word]);
    if ([step.text, joinedWords(step.text), ...spelled].some((text) => UNLOCK_STEM.test(text))) return UNLOCK_NAMED;
  }
  const found = pathSteps(command, cwd, backticks);
  // Git may write in a git folder, but not a file there whose name the guard can't read (`git bundle create
  // .git/x-$N`): that could be the unlock file.
  if (found.some((step) => step.name === "git" && GIT_FOLDER_WORD.test(step.text) && /[$`{*?]/.test(step.text)))
    return UNLOCK_NAMED;
  const held = guardRoots(env).filter((root) => !unlocked(root));
  if (!held.length) return undefined;
  if (found.some((step) => stepWrites(step, held, command))) return SELF_EDIT;
  const code = interpreterPipelines(command, backticks);
  if (code.some((text) => /\.claude[\\/]+(hooks|settings)|neutral\.ts/i.test(text))) return SELF_EDIT;
  return undefined;
}

/** A word that is, or is in, a git folder. */
const GIT_FOLDER_WORD = /(^|[\s"'=/\\])\.git([\\/\s"']|$)/i;

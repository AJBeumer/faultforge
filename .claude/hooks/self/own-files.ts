/**
 * The guard's own code, in the checkout it runs from. The hooks Claude Code and git run
 * are the files in that checkout: `.claude/hooks/**`, the settings that register them (`.claude/settings.json`,
 * `.claude/settings.local.json`), the word list they import (`packages/harness/src/shared/neutral.ts`) and the door every
 * write to a reviewed repo goes through (`packages/harness/src/door/target-post*.ts`). An owner
 * session that rewrote one of them, emptied it or deleted it would switch the guard off for every later command,
 * git's commits and pushes included. So no shell command and no Write or Edit changes them there. The repo's main
 * checkout is held too when the guard runs from a linked worktree: later sessions run from there.
 *
 * The owner changes the guard through a normal PR, from another worktree or a clone, which is not held. For a change
 * made in a held checkout itself, the owner unlocks the repo by hand: an empty file named `faultforge-guard-unlock`
 * in its main git folder (`.git/`), deleted again afterwards. Why a file, and not "allowed off main": a session can
 * switch branches itself (`git switch -c x`), and the edited guard would then run at once. The unlock file sits in
 * the git folder, which no program but git may write (self/git-hooks.ts), and no command may name it, so the session
 * can't make it; only the owner can, outside it.
 *
 * Refused while locked:
 *  - a program that writes, deletes or moves files (`rm`, `mv`, `tee`, `sed -i`, `Remove-Item`, …) naming one of
 *    them, a folder they are in, or a wildcard or brace list that matches one; a copy or link whose destination is
 *    one, or a folder that would take one (`cp -r x/.claude .`); a redirect into one;
 *  - git commands that would put another version of them in place (self/own-files-git.ts);
 *  - inline interpreter code that names them, or the `.claude` folder (`node -e "fs.rmSync('.claude', …)"`);
 *  - a Write or Edit of one of them.
 * Refused always: any command that does more than read and names the unlock file.
 * A script file can still write anything the session can: that is the limit of reading commands, as elsewhere.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { existingFolder, LAB_ROOT, within } from "../shared/repos.ts";
import { braces } from "../shell/glob.ts";
import { interpreterPipelines } from "../shell/interp.ts";
import {
  COPIERS,
  copyEnds,
  MOVERS,
  type PathStep,
  pathSteps,
  RECURSIVE,
  realPlace,
  TOO_MANY_PATHS,
  tooManyPaths,
} from "../shell/paths.ts";
import { outsidePostedText } from "../shell/posted.ts";
import { steps, words } from "../shell/words.ts";
import { calls } from "../target/history.ts";
import { onlyReads } from "./git-hooks.ts";
import { gitSelfProblem } from "./own-files-git.ts";

/** The unlock file's name, in the main git folder of the repo the guard runs from. */
export const UNLOCK_FILE = "faultforge-guard-unlock";
/** The name in any spelling a word could give it: separators, or none, between its parts. */
const UNLOCK_STEM = /guard[-_.]*unlock/i;

/** The guard's own files, relative to its checkout, with `/` and in lower case: a folder ends in `/`. */
export const OWN_FILES = [
  ".claude/hooks/",
  ".claude/settings.json",
  ".claude/settings.local.json",
  "packages/harness/src/shared/neutral.ts",
  // The door: the guard lets `npm run target:post` through unread because these check what it sends.
  "packages/harness/src/door/target-post.ts",
  "packages/harness/src/door/target-post-push.ts",
  "packages/harness/src/door/target-post-cli.ts",
  // Its run gate: the kinds an agent may use while a factory run is active.
  "packages/harness/src/door/target-post-run.ts",
];

/** Programs that write, delete or change the mode of the files they name. */
const WRITERS =
  /^(rm|rmdir|unlink|shred|touch|truncate|tee|dd|chmod|chown|chattr|patch|del|erase|rd|ren|rename|remove-item|ri|rename-item|rni|set-content|sc|add-content|ac|out-file|new-item|ni|clear-content|clc|set-item|si)$/;
/** Editors that write in place only with `-i`. */
const IN_PLACE = /^(sed|perl|ruby)$/;

/** A checkout's own git folder (a worktree's `.git` file points to it), and the repo's main one (`commondir`). */
function gitFolders(root: string): { own: string; common: string } {
  const dotGit = join(root, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return { own: dotGit, common: dotGit };
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim() ?? "";
    const own = isAbsolute(pointer) ? pointer : resolve(root, pointer);
    const common = join(own, "commondir");
    return { own, common: existsSync(common) ? resolve(own, readFileSync(common, "utf8").trim()) : own };
  } catch {
    return { own: dotGit, common: dotGit };
  }
}

/** The checkouts whose guard files are held: the one this guard runs from, its repo's main one, and one a test names. */
export function guardRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = [LAB_ROOT, ...(env.FAULTFORGE_GUARD_ROOT ? [resolve(env.FAULTFORGE_GUARD_ROOT)] : [])];
  const main = roots.map((root) => gitFolders(root).common).filter((common) => basename(common) === ".git");
  return [...new Set([...roots, ...main.map((common) => dirname(common))])];
}

/** True when the owner has unlocked the repo's guard files by hand. */
export function unlocked(root: string): boolean {
  return existsSync(join(gitFolders(root).common, UNLOCK_FILE));
}

/** The held checkouts that are still locked. */
export const lockedRoots = (env: NodeJS.ProcessEnv) => guardRoots(env).filter((root) => !unlocked(root));

const fold = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);

/**
 * How a path relates to the guard's files in `root`: one of them (or in one), a folder holding one, or neither. As
 * written, and where it really leads through a link on the way; `cache` keeps each folder's real place for a step.
 */
export function relation(path: string, root: string, cache = new Map<string, string>()): "own" | "holds" | undefined {
  let found: "own" | "holds" | undefined;
  for (const place of [path, realPlace(path, cache)]) {
    const rel = fold(relative(root, place).replace(/\\/g, "/"));
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    if (OWN_FILES.some((own) => (own.endsWith("/") ? `${rel}/`.startsWith(own) : rel === own))) return "own";
    if (rel === "" || OWN_FILES.some((own) => own.startsWith(`${rel}/`))) found = "holds";
  }
  return found;
}

/** The deny reason for a change to the guard's own files. */
export const SELF_EDIT = `This would change the guard's own files (.claude/hooks, .claude/settings*.json, neutral.ts or the target-post door) in the checkout it runs from, which would switch it off. Change them through a PR from another worktree; for a change in this checkout the owner unlocks it by hand (${UNLOCK_FILE} in its git folder).`;

export const UNLOCK_NAMED =
  "This names the guard's unlock file. Only the owner makes or removes it, by hand, outside a session.";

/** Why a Write or Edit of `path` is refused, or undefined. */
export function selfFileEdit(path: string, env: NodeJS.ProcessEnv): string | undefined {
  if (UNLOCK_STEM.test(basename(path))) return UNLOCK_NAMED;
  return lockedRoots(env).some((root) => relation(path, root) === "own") ? SELF_EDIT : undefined;
}

/** True when a step other than git writes one of the guard's files in a held checkout. */
function stepWrites(step: PathStep, held: string[], command: string): boolean {
  // Each path is looked up once: a copy names its sources again under its destination.
  const seen = new Map<string, "own" | "holds" | undefined>();
  const folders = new Map<string, string>();
  const related = (path: string) => {
    if (!seen.has(path)) {
      const found = held.map((root) => relation(path, root, folders));
      seen.set(path, found.includes("own") ? "own" : found.includes("holds") ? "holds" : undefined);
    }
    return seen.get(path);
  };
  const own = (path: string) => related(path) === "own";
  const touches = (path: string) => related(path) !== undefined;
  if (step.redirects.some(own)) return true;
  if (step.name === "git") return false;
  if (COPIERS.test(step.name) || MOVERS.test(step.name)) {
    const { sources, destination } = copyEnds(step);
    const landing = destination.flatMap((d) => [d, ...sources.map((s) => join(d, basename(s)))]);
    if (landing.some(own)) return true;
    if (step.args.some((w) => RECURSIVE.test(w)) && landing.some(touches)) return true;
    // A move removes what it names, too.
    if (MOVERS.test(step.name) && sources.some(touches)) return true;
  }
  const writer = WRITERS.test(step.name) || (IN_PLACE.test(step.name) && step.args.some((w) => /^-[a-z]*i/.test(w)));
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
  // The unlock file, in any spelling a brace list or the shell's quotes could build, by any command that does more
  // than read. Only words that could be a path count: words in a message, or text with a space in it, name no file.
  for (const step of steps(outsidePostedText(command), backticks)) {
    if (onlyReads(step.text, backticks)) continue;
    const spelled = words(step.text)
      .map((word) => word.replace(/["'`\\]/g, ""))
      .flatMap((word) => braces(word) ?? [word]);
    if (spelled.some((word) => UNLOCK_STEM.test(word))) return UNLOCK_NAMED;
  }
  const found = pathSteps(command, cwd, backticks);
  // Git may write in a git folder, but not a file there whose name the guard can't read (`git bundle create
  // .git/x-$N`): that could be the unlock file.
  if (found.some((step) => step.name === "git" && GIT_FOLDER_WORD.test(step.text) && /[$`{*?]/.test(step.text)))
    return UNLOCK_NAMED;
  const held = lockedRoots(env);
  if (!held.length) return undefined;
  const writes = (step: PathStep) =>
    WRITERS.test(step.name) || COPIERS.test(step.name) || MOVERS.test(step.name) || step.redirects.length > 0;
  if (found.some((step) => writes(step) && tooManyPaths(step))) return TOO_MANY_PATHS;
  if (found.some((step) => stepWrites(step, held, command))) return SELF_EDIT;
  for (const call of calls(outsidePostedText(command), cwd, backticks)) {
    if (call.program !== "git") continue;
    const root = call.dir === undefined ? held[0] : held.find((r) => within(call.dir ?? "", r));
    if (root && gitSelfProblem(call, root, (path) => held.some((r) => relation(path, r) !== undefined)))
      return SELF_EDIT;
  }
  const code = interpreterPipelines(command, backticks);
  if (code.some((text) => /\.claude(?![\w-])|neutral\.ts/i.test(text))) return SELF_EDIT;
  return undefined;
}

/** A word that is, or is in, a git folder. */
const GIT_FOLDER_WORD = /(^|[\s"'=/\\])\.git([\\/\s"']|$)/i;

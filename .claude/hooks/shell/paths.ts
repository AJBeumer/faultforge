/**
 * The files each step of a shell command names, resolved as the shell would find them: from the folder the step
 * runs in, followed through `cd`, `pushd` and `Set-Location`, with quotes and escapes removed as the shell joins a
 * word (`".claude"/hooks`), Git Bash's drive spelling read (`/d/x` is `D:\x` on Windows), wildcards and brace lists
 * expanded against what exists, and the files its redirects read and write apart. Shared by the checks on the
 * guard's own files (self/own-files.ts) and on copies out of private storage (answer-key/copies.ts), re-grade 6. Words
 * in a commit message or a post body are posted text, not paths, and are left out.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { existingFolder } from "../shared/repos.ts";
import { braces, globMatches, hasWildcard } from "./glob.ts";
import { outsidePostedText } from "./posted.ts";
import { MOVES, programAt, programName, steps, unreadable, words } from "./words.ts";

/** One step: its program, its words after it, the paths they name, and the files its redirects read and write. */
export interface PathStep {
  text: string;
  name: string;
  args: string[];
  /** Every path a word names, resolved: a wildcard's matches, and the pattern itself as written. */
  paths: string[];
  /** The paths a word names, one list per word, in order, for a program whose last word is its destination. */
  perWord: string[][];
  /** Files a `>` or `>>` redirect writes, resolved. */
  redirects: string[];
  /** Files a `<` redirect reads, resolved. */
  inputs: string[];
  /** True when a word or the folder can't be read before the step runs (`$X`, `$(…)`, `cd "$D"`). */
  unknown: boolean;
}

/** Programs that copy or link what they name to their last word, which is the only one they write. */
export const COPIERS = /^(cp|copy|copy-item|cpi|install|rsync|scp|ln|mklink|xcopy|robocopy)$/;
/** Programs that move what they name to their last word: they write it, and remove the others. */
export const MOVERS = /^(mv|move|move-item|mi)$/;
/** A flag that makes a copy take a whole folder. */
export const RECURSIVE = /^(-[a-z]*[rRa][a-z]*|--recursive|--archive|-recurse|\/s|\/e)$/i;

/** A redirect's target that writes no file: another descriptor or the null device. */
const HARMLESS = /^(&\d*|\/dev\/null|nul|\$null)$/i;

/** A word as the shell passes it on: quotes removed wherever they are, and in bash its escapes too. */
function spoken(word: string, backticks: boolean): string {
  return (backticks ? word.replace(/\\(.)/g, "$1") : word).replace(/["']/g, "");
}

/** A word's path as the shell would read it from `here`: a leading `~`, and Git Bash's `/d/…` on Windows. */
function located(word: string, here: string): string {
  if (word === "~" || word.startsWith("~/") || word.startsWith("~\\")) return join(homedir(), word.slice(1));
  const drive = process.platform === "win32" ? /^\/([a-zA-Z])(\/.*)?$/.exec(word) : null;
  if (drive) return resolve(`${drive[1]}:/`, `.${drive[2] ?? ""}`);
  return resolve(here, word);
}

/** What one path word names from `here`: its brace variants and wildcard matches, and each variant as written. */
function expand(word: string, here: string): string[] {
  const variants = braces(word) ?? [word];
  const out = variants.map((variant) => located(variant, here));
  if (hasWildcard(word)) out.push(...(globMatches(word, here) ?? []));
  return out;
}

/** Every step of the command with the paths it names. `cwd` is where the command starts. */
export function pathSteps(command: string, cwd: string, backticks = true): PathStep[] {
  let here: string | undefined = cwd;
  const found: PathStep[] = [];
  for (const step of steps(outsidePostedText(command), backticks)) {
    const all = words(step.text).map((word) => spoken(word, backticks));
    const { at } = programAt(all);
    const name = programName(all[at] ?? "");
    const rest = all.slice(at + 1);
    if (MOVES.test(name)) {
      const to = rest.find((w) => !w.startsWith("-"));
      if (!to) here = homedir();
      else here = here && !unreadable(to) ? located(to, here) : undefined;
      continue;
    }
    if (name === "popd") here = undefined;
    const redirects: string[] = [];
    const inputs: string[] = [];
    const args: string[] = [];
    let unknown = here === undefined;
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i] ?? "";
      // `<<` and `<<<` feed text, not a file: a heredoc or a here-string.
      if (/^\d*<</.test(word)) continue;
      const redirect = /^(\d*>>?\||\d*>>?|&>>?|\d*<(?!\())(.*)$/.exec(word);
      if (redirect) {
        const target = redirect[2] || rest[++i] || "";
        if (target && !HARMLESS.test(target)) {
          if (unreadable(target) || !here) unknown = true;
          else (redirect[1]?.endsWith("<") ? inputs : redirects).push(located(target, here));
        }
        continue;
      }
      args.push(word);
    }
    const perWord: string[][] = [];
    for (const arg of args) {
      // An option's own value counts as a path too: `--target-directory=x`, `of=x`, `-Path:x`.
      const value = /^(?:--?[\w-]+[=:]|of=|if=)(.+)$/i.exec(arg)?.[1] ?? (arg.startsWith("-") ? "" : arg);
      if (!value) continue;
      if (unreadable(value) || !here) {
        unknown = true;
        perWord.push([]);
        continue;
      }
      perWord.push(expand(value, here));
    }
    const paths = [...new Set(perWord.flat())];
    found.push({ text: step.text, name, args, paths, perWord, redirects, inputs, unknown });
  }
  return found;
}

/** A copy's sources and destination: every word but the last, and the last, each as the paths it names. */
export function copyEnds(step: PathStep): { sources: string[]; destination: string[] } {
  const named = step.perWord.filter((list) => list.length);
  return { sources: [...new Set(named.slice(0, -1).flat())], destination: named.at(-1) ?? [] };
}

/** The most distinct paths one step may name and still be read: each costs a look at the file system (AUD-M4). */
export const MAX_PATHS = 256;
export const TOO_MANY_PATHS = `This command names more than ${MAX_PATHS} files in one step, more than the guard reads. Split it.`;

/** True when a step names more distinct paths than the guard reads. */
export const tooManyPaths = (step: PathStep) => step.paths.length + step.redirects.length > MAX_PATHS;

/**
 * Where a path really is, through links on the way to it (a linked folder, or the path itself), with the real place
 * of each existing folder looked up once per `cache`: a step that names many files in one folder costs one look.
 */
export function realPlace(path: string, cache: Map<string, string>): string {
  const existing = existingFolder(path);
  let real = cache.get(existing);
  if (real === undefined) {
    try {
      real = realpathSync.native(existing);
    } catch {
      real = existing;
    }
    cache.set(existing, real);
  }
  return join(real, relative(existing, path));
}

/** True when `path` is `folder` or inside it, as written or where either really is, case-blind on Windows. */
export function insideReal(path: string, folder: string, cache: Map<string, string>): boolean {
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const folders = existsSync(folder) ? [folder, realPlace(folder, cache)] : [folder];
  return [path, realPlace(path, cache)].some((place) =>
    folders.some((f) => {
      const rel = relative(fold(f), fold(place));
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    }),
  );
}

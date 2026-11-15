/**
 * The files each step of a shell command names, resolved as the shell would find them: from the folder the step
 * runs in, followed through `cd`, `pushd` and `Set-Location`, with wildcards and brace lists expanded against what
 * exists, and the targets of its redirects apart. Shared by the checks on the guard's own files (guard-self.ts) and
 * on copies out of private storage (guard-answer-key.ts), re-grade 6. Words in a commit message or a post body are
 * posted text, not paths, and are left out.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { outsidePostedText } from "./guard-posted.ts";
import { braces, globMatches, hasWildcard } from "./shell-glob.ts";
import { programAt, programName, steps, unquote, words } from "./shell-words.ts";

/** One step: its program, its words after it, the paths they name, and the files its redirects write. */
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
  /** True when a word or the folder can't be read before the step runs (`$X`, `$(…)`, `cd "$D"`). */
  unknown: boolean;
}

const MOVES = /^(cd|pushd|chdir|set-location|sl)$/;
const unreadable = (word: string) => /[$`%]/.test(word);
/** Redirects that write no file: to another descriptor or to the null device. */
const HARMLESS = /^(&\d*|\/dev\/null|nul|\$null)$/i;

/** A word's path as the shell would expand a leading `~`, from `here`. */
function located(word: string, here: string): string {
  if (word === "~" || word.startsWith("~/") || word.startsWith("~\\")) return join(homedir(), word.slice(1));
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
    const all = words(step.text).map(unquote);
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
    const args: string[] = [];
    let unknown = here === undefined;
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i] ?? "";
      const redirect = /^\d*>>?\|?(.*)$/.exec(word) ?? /^&>>?(.*)$/.exec(word);
      if (redirect) {
        const target = redirect[1] || rest[++i] || "";
        if (target && !HARMLESS.test(target)) {
          if (unreadable(target) || !here) unknown = true;
          else redirects.push(located(target, here));
        }
        continue;
      }
      if (/^\d*</.test(word)) continue;
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
    found.push({ text: step.text, name, args, paths: perWord.flat(), perWord, redirects, unknown });
  }
  return found;
}

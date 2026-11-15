/**
 * The files a gist or a release would publish (re-grade 3), read as the shell would run the command (Qodo on PR
 * 310): its words with quotes and escapes removed (`gh gi''st create`), its wildcards and brace lists expanded
 * (`private/*`), and for a gist the files its stdin comes from (`gh gist create - < f`, `cat f | gh gist create`).
 * Split out of guard-files.ts, which may not pass 400 lines.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readPosted, Unreadable } from "./guard-files.ts";
import { navigationTargets } from "./guard-repos.ts";
import { spokenWords } from "./shell-decode.ts";
import { globMatches, hasWildcard } from "./shell-glob.ts";
import { programAt, programName, type Step, steps, words } from "./shell-words.ts";

/** One file (or folder) a gist or a release would publish from: where it is, its text, and whether a gist would. */
export interface Asset {
  path: string;
  text: string;
  gist: boolean;
}

/** Programs whose output is the text of the files they name, so that text is what a gist fed by them posts. */
const READERS = /^(cat|type|get-content|gc|tac|head|tail)$/;

/**
 * Every folder a relative file name in the command could be read from: the folder the hook runs in, and each
 * folder the command moves into before it. Reading one file too many is harmless.
 */
function folders(cwd: string, command: string): string[] {
  return [...new Set([cwd, ...navigationTargets(command, cwd)])];
}

/**
 * The paths a word names: itself from every folder, or with a wildcard every path it matches. A wildcard with too
 * many matches to list can't be checked, so it throws.
 */
function named(cwd: string, command: string, word: string): string[] {
  const dirs = folders(cwd, command);
  if (!hasWildcard(word)) return isAbsolute(word) ? [word] : dirs.map((dir) => resolve(dir, word));
  return dirs.flatMap((dir) => {
    const matches = globMatches(word, dir);
    if (!matches) {
      throw new Unreadable(
        "This gist or release names a wildcard that matches more files than the guard can check. Name the files.",
      );
    }
    return matches;
  });
}

/** The gist or release a step runs, as the shell reads its words, or undefined when it runs neither. */
function publishes(step: Step): { gist: boolean; args: string[]; raw: string[] } | undefined {
  const raw = words(step.text.split("\n")[0] ?? "");
  const at = programAt(raw).at;
  if (programName(raw[at] ?? "") !== "gh") return undefined;
  const spoken = raw.map((w) => spokenWords(w));
  const [group = "", action = ""] = spoken.slice(at + 1, at + 3).map((w) => w.toLowerCase());
  const gist = group === "gist" && /^(create|edit|new)$/.test(action);
  if (!gist && !(group === "release" && /^(create|upload)$/.test(action))) return undefined;
  return { gist, args: spoken.slice(at + 3), raw: raw.slice(at + 3) };
}

/**
 * The files a gist or a release would publish: every word after `gh gist create|edit` or `gh release
 * create|upload` that names an existing file, from every folder the command could read it from. A flag's value is
 * read too when it names a file: reading one file too many is harmless, and skipping a flag that takes no value
 * would skip the file after it. A release asset may carry a label (`file#label`). Words that are no file (a
 * release's tag) are skipped: gh fails on a missing asset, so nothing unread is posted. A secret gist counts as
 * much as a public one. A gist also reads stdin (`-`, or no file at all): each file redirected into it, and each
 * file or folder named by the steps that pipe into it, counts as published.
 */
export function assetFiles(cwd: string, command: string, backticks = true): Asset[] {
  const assets: Asset[] = [];
  const add = (path: string, gist: boolean, read: boolean) => {
    if (!existsSync(path)) return;
    const file = statSync(path).isFile();
    if (!read) assets.push({ path, text: "", gist });
    else if (file) for (const text of readPosted(cwd, command, path)) assets.push({ path, text, gist });
  };
  const pipelines: Step[][] = [];
  for (const step of steps(command, backticks)) {
    const last = pipelines[pipelines.length - 1];
    if (step.piped && last) last.push(step);
    else pipelines.push([step]);
  }
  for (const pipeline of pipelines) {
    pipeline.forEach((step, index) => {
      const run = publishes(step);
      if (!run) return;
      for (let i = 0; i < run.args.length; i++) {
        const word = run.args[i] ?? "";
        if (/[$`]|%\w+%/.test(run.raw[i] ?? "")) {
          throw new Unreadable(
            "This gist or release names a word the shell builds at run time, so the guard can't read what it would publish. Name the files as written.",
          );
        }
        // A redirect: `< f` feeds a gist its stdin, a heredoc's text is in the command, `> f` writes.
        const redirect = /^(\d*)(<<<|<<|<|>>|>|&>)(.*)$/.exec(word);
        if (redirect) {
          const target = redirect[3] || run.args[++i] || "";
          if (redirect[2] === "<" && run.gist) for (const path of named(cwd, command, target)) add(path, true, true);
          continue;
        }
        // `--add=<file>` and the like: the value after `=`.
        const value = word.replace(/^--?[\w-]+=/, "");
        if (!value || value.startsWith("-")) continue;
        for (const file of new Set([value, value.replace(/#[^\\/]*$/, "")])) {
          for (const path of named(cwd, command, file)) add(path, run.gist, true);
        }
      }
      if (!run.gist) return;
      // What pipes into a gist is published: a reader's files as text, any other step's files and folders by path.
      for (const before of pipeline.slice(0, index)) {
        const raw = words(before.text.split("\n")[0] ?? "");
        const at = programAt(raw).at;
        const reader = READERS.test(programName(raw[at] ?? ""));
        for (const word of raw.slice(at + 1).map((w) => spokenWords(w).replace(/^\d*<|^--?[\w-]+=/, ""))) {
          if (!word || word.startsWith("-")) continue;
          for (const path of named(cwd, command, word)) add(path, true, reader);
        }
      }
      // A step that pipes into a gist from a folder reads that folder, whatever it names.
      if (index > 0) for (const dir of folders(cwd, command)) add(dir, true, false);
    });
  }
  // Text can reach a gist or a release in more ways than a pipe: a subshell (`(cat f) | gh gist create`), a group,
  // a process substitution (`<(cat f)`), a here-string of a substitution. So in a command that publishes, every
  // file or folder any word names, read as the shell splits it at those marks, counts too (Qodo on PR 312).
  const runs = pipelines.flat().flatMap((step) => publishes(step) ?? []);
  if (runs.length) {
    const gist = runs.some((run) => run.gist);
    for (const word of spokenWords(command).split(/[\s;&|()<>{}]+/)) {
      const value = word.replace(/^--?[\w-]+=/, "");
      if (!value || value.startsWith("-") || /[$`]/.test(value)) continue;
      for (const path of named(cwd, command, value)) add(path, gist, false);
    }
  }
  return assets;
}

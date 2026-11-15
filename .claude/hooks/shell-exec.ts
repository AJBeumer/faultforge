/**
 * Code a command runs that no text rule can read before it runs (second re-grade after round 4), shared by the
 * guard and the factory policy:
 *  - text built or read at run time and run as shell code: a decoder's output piped into a shell
 *    (`… | base64 -d | bash`), a substitution or a variable handed to `bash -c`, `sh -c`, `cmd /c`, `eval`,
 *    `iex` or `source <(…)`, and a substitution or a variable run as the command itself (`$(…)`). Only a literal
 *    the hooks can read may be run that way (`bash -c 'npm test'`, `echo 'ls' | sh`);
 *  - inline code in an interpreter (`node -e`, `python -c`, `perl -e`, `ruby -e`, a heredoc fed to one) that
 *    starts another program (`system`, `subprocess`, `child_process`) or runs code it builds (`exec`, `eval`):
 *    counted as built code (re-grade 3);
 *  - inline code in an interpreter that makes a network call: it can post to a reviewed repo without gh, where
 *    the guard reads nothing (shell-interp.ts, exported here again).
 * Both are refused outright: a decoder can be anything (`base64 -d`, `xxd -r`, `rev`, `openssl enc -d`,
 * `printf '\x..'`), so the rule is about where the text goes, not how it was made.
 */
import { decodeAnsiC } from "./shell-decode.ts";
import { subprocessCode } from "./shell-interp.ts";
import { blankQuoted, substitutions } from "./shell-scan.ts";
import { programAt, programName, type Step, steps, words } from "./shell-words.ts";

export {
  INLINE_NETWORK_REASON,
  inlineNetworkProblem,
  interpreterPipelines,
  LOCAL_HOSTS,
  NETWORK_CODE,
  onlyLocalCalls,
} from "./shell-interp.ts";

/** The denial for text run as shell code. It never quotes the command, which could hold a private id. */
export const BUILT_CODE_REASON =
  "This command runs text it builds or reads at run time as shell code: a decoded string, a substitution or a variable piped or passed to a shell, eval or source, or run as the command, or inline interpreter code that starts another program. No hook can read that code before it runs. Run the command itself, written out.";

/** Programs that run their input as shell code. */
const SHELLS = /^(bash|sh|zsh|dash|ksh|mksh|ash|fish|pwsh|powershell|cmd)$/i;
/** Builtins that run their arguments, or a file they name, as shell code. */
const EVALS = /^(eval|iex|invoke-expression)$/i;
const SOURCES = /^(source|\.)$/i;

/** The text with single-quoted parts blanked: what is left is what the shell expands. */
const expanding = (text: string) => text.replace(/'[^']*'/g, "''");

/** True when the shell builds part of the text at run time: a substitution, a backtick, a variable. */
const BUILT = /\$\(|`|\$\{?[A-Za-z_]|<\(|%[A-Za-z_]\w*%/;

/** True when the step only echoes a literal: text the hooks read as written. */
function literalEcho(step: string): boolean {
  const all = words(step);
  const name = programName(all[0] ?? "");
  if (!/^(echo|printf)$/.test(name)) return false;
  const args = all.slice(1).join(" ");
  if (/(^|\s)-[a-zA-Z]*e/.test(args)) return false;
  return !/[$`\\]/.test(expanding(args)) && !(name === "printf" && /[%\\]/.test(args));
}

/** The code a word holds once its quotes are removed: what a shell given it would run. */
const unquote = (word: string) => word.replace(/^'([^']*)'$/s, "$1").replace(/^"(.*)"$/s, "$1");

/** True when the step runs built text as shell code. `before` is the step a pipe feeds it from. */
function stepProblem(step: Step, before: Step | undefined, backticks: boolean, depth: number): boolean {
  const all = words(step.text);
  const { at, xargs } = programAt(all);
  const raw = all[at] ?? "";
  const args = all.slice(at + 1);
  const name = programName(raw);
  const fed = step.piped && !(before && !before.piped && literalEcho(before.text));
  // A substitution or a variable run as the command: bash runs its value (`$(echo … | base64 -d)`).
  if (backticks && /^["']?(\$\(|`|\$\{?[A-Za-z_]\w*\}?["']?$)/.test(raw)) return true;
  // PowerShell's call operators run a variable or an expression the same way: `& $x`, `. (…)`.
  if (!backticks && /^[&.]$/.test(raw) && /^[$(]/.test(args[0] ?? "")) return true;
  if (/\[scriptblock\]\s*::\s*create/i.test(step.text)) return true;
  if (SHELLS.test(name)) {
    const flag = args.findIndex((w) =>
      name === "cmd" ? /^\/[ckr]$/i.test(w) : /^-[a-zA-Z]*c[a-zA-Z]*$|^-(command|ec|enc\w*|e)$/i.test(w),
    );
    if (flag >= 0) {
      if (/^-(ec|enc\w*|e)$/i.test(args[flag] ?? "") && /^(pwsh|powershell)$/.test(name)) return true;
      const code = args.slice(flag + 1);
      if (code.some((w) => BUILT.test(expanding(w)))) return true;
      if (xargs || fed) return true;
      return depth < 3 && builtCode(code.map(unquote).join(" "), backticks, depth + 1);
    }
    // No inline code: the shell reads its code from stdin or from a file it names.
    if (xargs || fed) return true;
    if (args.some((w) => /^(<\(|\$\(|`)|^\/dev\/(stdin|fd\/)|^-s?$/.test(w))) return true;
    if (/<<<\s*\S/.test(step.text) && BUILT.test(expanding(step.text.slice(step.text.indexOf("<<<"))))) return true;
    if (/<\s*<\(/.test(step.text)) return true;
    const heredoc = /<<-?\s*(\S+)[^\n]*\n([\s\S]*)$/.exec(step.text);
    if (heredoc && !/['"\\]/.test(heredoc[1] ?? "") && BUILT.test(heredoc[2] ?? "")) return true;
    return false;
  }
  if (EVALS.test(name)) {
    if (xargs || step.piped) return true;
    // PowerShell's `Invoke-Expression (…)` and `iex $x` build the code too.
    if (args.some((w) => BUILT.test(expanding(w)) || /^[($]/.test(w))) return true;
    return depth < 3 && builtCode(args.map(unquote).join(" "), backticks, depth + 1);
  }
  if (SOURCES.test(name)) {
    if (xargs || step.piped) return true;
    return args.some((w) => /^(<\(|\$\(|`|\$)|^\/dev\/(stdin|fd\/)|^-$/.test(w));
  }
  return false;
}

/** True when the command runs built text as shell code, read as written and with ANSI-C strings decoded. */
function builtCode(command: string, backticks: boolean, depth = 0): boolean {
  for (const text of new Set([command, decodeAnsiC(command)])) {
    if (subprocessCode(text, backticks)) return true;
    const all = steps(text, backticks);
    if (all.some((step, i) => stepProblem(step, all[i - 1], backticks, depth))) return true;
    // What a substitution runs is a command too: `gh pr create -b "$(… | base64 -d | sh)"`.
    if (depth < 3 && substitutions(text, backticks).some((s) => builtCode(s.inner, backticks, depth + 1))) return true;
  }
  return false;
}

/** Why the command may not run because it runs text built at run time as shell code, or undefined. */
export function builtCodeProblem(command: string, backticks = true): string | undefined {
  return builtCode(command, backticks) ? BUILT_CODE_REASON : undefined;
}

/**
 * True when a program in the command passes on text it reads from a file or a pipe as arguments, where the
 * guard never sees it (re-grade 5): `xargs` (it always reads its input), `parallel` given anything but `:::`
 * words, and a `--post-file` (wget), which posts a file's bytes.
 */
export function argumentsFromInput(command: string, backticks = true): boolean {
  if (/(?:^|\s)--post-file\b/.test(blankQuoted(command))) return true;
  return steps(command, backticks).some((step) => {
    const all = words(step.text);
    const { at, xargs } = programAt(all);
    if (xargs) return true;
    if (programName(all[at] ?? "") !== "parallel") return false;
    const args = all.slice(at + 1);
    const fromFile = args.some((w) => /^(::::\+?|-a|--arg-file|--a)$|^--arg-file=|^-a\S/.test(w));
    return step.piped || fromFile || /<(?!<)/.test(blankQuoted(step.text)) || !args.includes(":::");
  });
}

/** Programs that run a script file named as their first argument that isn't an option. */
const SCRIPT_RUNNERS =
  /^(node|nodejs|tsx|ts-node|deno|bun|python[\d.]*|py|pypy[\d.]*|ruby|perl|php|lua|Rscript|bash|sh|zsh|dash|ksh|pwsh|powershell)$/i;

/** A script file a command runs, and whether it may be missing (a Python module that may be installed, not local). */
export interface ScriptFile {
  file: string;
  optional: boolean;
}

/** True when `word` hands the runner inline code instead of a file (`-e`, `bash -lc`, `php -r`, `pwsh -Command`). */
function inlineFlag(name: string, word: string): boolean {
  if (/^(bash|sh|zsh|dash|ksh)$/.test(name)) return /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word);
  if (/^(pwsh|powershell)$/.test(name)) return /^-(c|Command|EncodedCommand|ec|e)$/i.test(word);
  if (name === "php") return word === "-r";
  if (/^(python|py|pypy)/.test(name)) return word === "-c";
  return /^(-e|-p|-pe|-ne|-E|--eval|--print)$/.test(word);
}

/** A word that names a script file by its extension. */
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/i;

/** A word that names a local file, not a package: `./x`, `../x`, an absolute path, or a name with an extension. */
const localPath = (word: string) => /^(\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(word);

/** The script files one step runs; see `scriptFiles`. */
function stepScripts(text: string): ScriptFile[] {
  const all = words(text);
  const { at } = programAt(all);
  const program = unquote(all[at] ?? "");
  // A script run as the program itself (`./post.mjs`), through its shebang (Qodo on PR 329).
  if (/^\.{1,2}[\\/]/.test(program)) return [{ file: program, optional: false }];
  const name = programName(program);
  if (!SCRIPT_RUNNERS.test(name)) return [];
  const found: ScriptFile[] = [];
  for (let i = at + 1; i < all.length; i++) {
    const word = unquote(all[i] ?? "");
    if (inlineFlag(name, word)) return found;
    // Subcommands: `deno run x.ts`, `bun x y`, `tsx watch x.ts`. Any other bare word to deno or bun is a
    // subcommand of its own (`bun install`, `deno test`): then only the script files it is given are read
    // (`deno test ./post_test.ts`), never a package name (Qodo on PR 329).
    if (/^(deno|bun|tsx)$/.test(name) && i === at + 1 && /^(run|x|watch)$/.test(word)) continue;
    if (/^(deno|bun)$/.test(name) && i === at + 1 && /^[a-z]+$/.test(word)) {
      const files = all
        .slice(i + 1)
        .map(unquote)
        .filter((w) => !w.startsWith("-") && SCRIPT_FILE.test(w));
      return [...found, ...files.map((file) => ({ file, optional: false }))];
    }
    // `python -m mod` runs a local module when there is one (Qodo on PR 329); an installed one is not read.
    if (/^(python|py|pypy)/.test(name) && word === "-m") {
      const module = (all[i + 1] ?? "").replace(/\./g, "/");
      return module
        ? [...found, { file: `${module}.py`, optional: true }, { file: `${module}/__main__.py`, optional: true }]
        : found;
    }
    if (/^-File$/i.test(word)) continue;
    // A preload runs too: node's `--require ./x`, `--import ./x`, `--loader ./x` (Qodo on PR 329). A package
    // name there (`--import tsx`) is installed code, not read. Python's `-W x` and `-X x` take a value.
    if (/^(-r|--require|--import|--loader|--experimental-loader|-W|-X)$/.test(word)) {
      const value = unquote(all[i + 1] ?? "");
      if (!/^-[WX]$/.test(word) && localPath(value)) found.push({ file: value, optional: false });
      i++;
      continue;
    }
    // Code from stdin (`-`, a heredoc, a here-string) is inline code, judged as such elsewhere.
    if (word === "-" || word.startsWith("<<")) return found;
    // An output redirect's file is no script; an input redirect's is, as the code it reads.
    if (/^\d*>{1,2}$/.test(word)) {
      i++;
      continue;
    }
    if (word === "<") continue;
    if (word.startsWith("-") || /^\d*[<>]/.test(word)) continue;
    return [...found, { file: word, optional: false }];
  }
  return found;
}

/**
 * The script files the command runs (re-grade 5): the first word after a script runner (`node post.mjs`,
 * `npx tsx x.ts`, `python3 -u post.py`, `deno run x.ts`, `pwsh -File x.ps1`) that isn't one of its options, a
 * local preload, a local `python -m` module, and a script run as the program (`./post.mjs`), in every step and
 * every substitution (`$(node post.mjs)`; Qodo on PR 329). A runner given inline code (`-e`, `bash -lc`) runs no
 * file; that code is judged elsewhere. What a script imports is not followed: only the file named is read.
 */
export function scriptFiles(command: string, backticks = true, depth = 0): ScriptFile[] {
  const own = steps(command, backticks).flatMap((step) => stepScripts(step.text));
  if (depth >= 3) return own;
  return [...own, ...substitutions(command, backticks).flatMap((s) => scriptFiles(s.inner, backticks, depth + 1))];
}

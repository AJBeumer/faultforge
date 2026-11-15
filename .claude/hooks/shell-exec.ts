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

/**
 * The script files the command runs (re-grade 5): the first word after a script runner (`node post.mjs`,
 * `npx tsx x.ts`, `python3 -u post.py`, `deno run x.ts`, `pwsh -File x.ps1`) that isn't one of its options. A
 * runner given inline code (`-e`, `-c`, `-Command`) or nothing runs no file; that code is judged elsewhere.
 */
export function scriptFiles(command: string, backticks = true): string[] {
  return steps(command, backticks).flatMap((step) => {
    const all = words(step.text);
    const { at } = programAt(all);
    const name = programName(all[at] ?? "");
    if (!SCRIPT_RUNNERS.test(name)) return [];
    let i = at + 1;
    if (/^(deno|bun)$/.test(name) && /^(run|x)$/.test(all[i] ?? "")) i++;
    for (; i < all.length; i++) {
      const word = all[i] ?? "";
      if (/^-(e|c|p|m|-eval|-print|Command|EncodedCommand|ec)$/i.test(word)) return [];
      if (/^-File$/i.test(word)) continue;
      // An option's value: node's `--require x`, `--import x`, `--loader x`; python's `-W x`, `-X x`.
      if (/^(-r|--require|--import|--loader|--experimental-loader|-W|-X)$/.test(word)) {
        i++;
        continue;
      }
      if (word.startsWith("-") || /^[<>]/.test(word)) continue;
      return [unquote(word)];
    }
    return [];
  });
}

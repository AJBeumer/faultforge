/**
 * How the hooks split a shell command the way the shell does: its simple commands (steps) at pipes and
 * separators outside quotes, substitutions and heredoc bodies; each step's words; and the program a step runs,
 * past assignments and words that run the next word (`sudo`, `env`, `npx`). Split out of shell/exec.ts, which
 * may not pass 400 lines (Qodo on PR 310 needed the steps for inline code too).
 */
import { spokenWords } from "./decode.ts";
import { quotedSpans } from "./scan.ts";

/** Words that run the next word as the program. `xargs` also feeds it its own input. */
export const PREFIXES =
  /^(sudo|doas|env|exec|command|builtin|nohup|time|nice|stdbuf|timeout|setsid|ionice|taskset|xargs|wsl|busybox|npx|pnpx|bunx|!|\(|\{)$/i;

/** Programs that move into a folder. */
export const MOVES = /^(cd|pushd|chdir|set-location|sl)$/;

/** True when the shell builds this word at run time (a variable, a substitution, `%VAR%`), so no hook can read it. */
export const unreadable = (word: string) => /[$`%]/.test(word);

/** Redirects that write no file: to another descriptor or to the null device. Use it with `replace`, never `test`. */
export const HARMLESS_REDIRECT = /\d?>&\d|\d?>\s*\/dev\/null|\d?>\s*nul\b/gi;

/** Index of the `)` closing the `$(` at `i`, past quoted text inside it, or the end of the text. */
function closeSubstitution(s: string, i: number): number {
  let depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "'") {
      const end = s.indexOf("'", j + 1);
      if (end < 0) return s.length;
      j = end;
    } else if (c === '"') j = closeDouble(s, j);
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j;
  }
  return s.length;
}

/** Index of the `"` closing the one at `i`, past substitutions inside it, or the end of the text. */
function closeDouble(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "$" && s[j + 1] === "(") j = closeSubstitution(s, j);
    else if (c === '"') return j;
  }
  return s.length;
}

/** A word with one level of single or double quotes around it removed. */
export const unquote = (word: string) => word.replace(/^'([^']*)'$/s, "$1").replace(/^"(.*)"$/s, "$1");

/** One simple command: its text, and whether a pipe feeds it the output of the step before. */
export interface Step {
  text: string;
  piped: boolean;
}

/**
 * The command's simple commands, split at `|`, `||`, `&&`, `;`, `&` and new lines outside quotes, substitutions
 * and heredoc bodies (a heredoc's body stays with the command it feeds). `backticks` is bash's reading; to
 * PowerShell a backtick escapes the next character.
 */
export function steps(command: string, backticks: boolean): Step[] {
  const literal = new Array<boolean>(command.length).fill(false);
  for (const span of quotedSpans(command))
    if (span.kind === "heredoc" || span.kind === "comment") literal.fill(true, span.start, span.end);
  const found: Step[] = [];
  let start = 0;
  let piped = false;
  const cut = (end: number, next: boolean) => {
    const text = command.slice(start, end).trim();
    if (text) found.push({ text, piped });
    piped = next;
  };
  for (let i = 0; i < command.length; i++) {
    if (literal[i]) continue;
    const c = command[i];
    const next = command[i + 1];
    if (c === "\\" || (c === "`" && !backticks)) i++;
    else if (c === "'") i = command.indexOf("'", i + 1) < 0 ? command.length : command.indexOf("'", i + 1);
    else if (c === '"') i = closeDouble(command, i);
    else if (c === "$" && next === "(") i = closeSubstitution(command, i);
    else if (c === "`") i = command.indexOf("`", i + 1) < 0 ? command.length : command.indexOf("`", i + 1);
    else if (c === "|") {
      const or = next === "|";
      cut(i, !or);
      if (or || next === "&") i++;
      start = i + 1;
    } else if (c === "&" && command[i - 1] !== ">" && next !== ">" && (backticks || next === "&")) {
      // To PowerShell a lone `&` is the call operator, not a separator.
      cut(i, false);
      if (next === "&") i++;
      start = i + 1;
    } else if (c === ";" || c === "\n") {
      cut(i, false);
      start = i + 1;
    }
  }
  cut(command.length, false);
  return found;
}

/** The step's words as the shell splits them, quotes and substitutions kept whole in their word. */
export function words(step: string): string[] {
  const out: string[] = [];
  let word = "";
  for (let i = 0; i < step.length; i++) {
    const c = step[i] ?? "";
    let end = i;
    if (/\s/.test(c)) {
      if (word) out.push(word);
      word = "";
      continue;
    }
    if (c === "\\") end = i + 1;
    else if (c === "'") end = step.indexOf("'", i + 1) < 0 ? step.length : step.indexOf("'", i + 1);
    else if (c === '"') end = closeDouble(step, i);
    else if (c === "$" && step[i + 1] === "(") end = closeSubstitution(step, i);
    else if (c === "`") end = step.indexOf("`", i + 1) < 0 ? step.length : step.indexOf("`", i + 1);
    word += step.slice(i, end + 1);
    i = end;
  }
  if (word) out.push(word);
  return out;
}

/** A program's name as a word: quotes and escapes removed, its folder and `.exe` dropped. */
export function programName(word: string): string {
  return (
    spokenWords(word)
      .replace(/^[({!]+/, "")
      .split(/[\\/]/)
      .pop() ?? ""
  )
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

/** Where the step's program is, past variable assignments and words that run the next word. */
export function programAt(all: string[]): { at: number; xargs: boolean } {
  let at = 0;
  let xargs = false;
  while (at < all.length) {
    const word = all[at] ?? "";
    if (/^[A-Za-z_]\w*=/.test(word)) at++;
    else if (PREFIXES.test(programName(word)) || /^[({!]$/.test(word)) {
      if (/^xargs$/i.test(programName(word))) xargs = true;
      at++;
      // A prefix's own flags and values: `timeout 5`, `nice -n 5`, `xargs -I{}`, `npx --yes`.
      while (at < all.length && /^(-|\d+(\.\d+)?[smhd]?$)/.test(all[at] ?? "")) {
        if (/^-(n|I|u|g|S|C|k|s)$/.test(all[at] ?? "") && at + 1 < all.length) at++;
        at++;
      }
    } else break;
  }
  return { at, xargs };
}

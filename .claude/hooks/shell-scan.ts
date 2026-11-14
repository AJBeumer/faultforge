/**
 * One linear pass over a shell command that finds its quoted text and heredoc bodies (AUD-M4). The guard
 * used regular expressions for this whose run time grew faster than the command: a crafted 5 KB command
 * kept the hook busy past its time limit, and Claude Code runs the tool when a hook times out. This scanner
 * visits each character a bounded number of times, and `MAX_COMMAND_CHARS` caps what any check reads.
 *
 * It reads bash's rules, which PowerShell mostly shares for this purpose: single quotes run to the next
 * single quote, double quotes to the next unescaped double quote, `#` at the start of a word is a comment to
 * the end of the line, and `<<WORD` (or `<<-WORD`) opens a heredoc whose body starts on the next line and
 * ends before the first line that is the delimiter alone (`<<-` lets tabs come before it). A body with no
 * such line runs to the end of the command. Quote marks and backslashes in the delimiter are removed, as the
 * shell does, and a quoted delimiter means the body doesn't expand `$(…)`.
 */

/** The longest command the guard reads. Anything longer is refused: post long text from a file instead. */
export const MAX_COMMAND_CHARS = 100_000;

export interface Span {
  /** Where the quoted part starts: the opening quote, or the newline before a heredoc body. */
  start: number;
  /** Where it ends (exclusive): after the closing quote, or after the heredoc's closing delimiter line. */
  end: number;
  kind: "single" | "double" | "heredoc" | "comment";
  /** A heredoc body's own text, from its first line to before its delimiter line. */
  body?: { start: number; end: number };
  /** True when the shell would run a command inside: `$(…)` or a backtick, in double quotes or an expanding body. */
  runs: boolean;
}

const OPENER = /<<(-?)[ \t]*((?:\\.|[^\s<>|;&()])+)/y;
const RUNS = /\$\(|`/;

/** Every quoted part and heredoc body in the command, in order, found in one pass. */
export function quotedSpans(command: string): Span[] {
  const spans: Span[] = [];
  const pending: { delimiter: string; tabs: boolean; quoted: boolean }[] = [];
  const n = command.length;
  let i = 0;
  let wordStart = true;
  while (i < n) {
    const c = command[i];
    if (c === "\n") {
      let at = i + 1;
      // Each heredoc opened on the line just ended takes its body from here, one after another.
      for (const doc of pending.splice(0)) {
        const spanStart = at - 1;
        const bodyStart = at;
        let bodyEnd = n;
        let close = n;
        while (at < n) {
          let eol = command.indexOf("\n", at);
          if (eol < 0) eol = n;
          let line = command.slice(at, eol);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
            bodyEnd = at;
            close = eol;
            break;
          }
          at = eol + 1;
        }
        if (bodyEnd === n) close = n;
        at = Math.min(close, n);
        // An escaped backslash is removed first, so `\\$(` reads as a real substitution; `\$(` stays literal.
        const text = command
          .slice(bodyStart, bodyEnd)
          .replace(/\\\\/g, "")
          .replace(/\\\$\(|\\`/g, "");
        spans.push({
          start: spanStart,
          end: close,
          kind: "heredoc",
          body: { start: bodyStart, end: bodyEnd },
          runs: !doc.quoted && RUNS.test(text),
        });
      }
      // `at` is the closing delimiter's line end (its newline is kept as a command separator), or the next line.
      i = at > i + 1 ? at : i + 1;
      wordStart = true;
      continue;
    }
    if (c === "\\") {
      i += 2;
      wordStart = false;
      continue;
    }
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close < 0 ? n : close + 1;
      spans.push({ start: i, end, kind: "single", runs: false });
      i = end;
      wordStart = false;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') j += command[j] === "\\" ? 2 : 1;
      const end = Math.min(n, j + 1);
      spans.push({ start: i, end, kind: "double", runs: RUNS.test(command.slice(i, end)) });
      i = end;
      wordStart = false;
      continue;
    }
    if (c === "#" && wordStart) {
      const eol = command.indexOf("\n", i);
      const end = eol < 0 ? n : eol;
      spans.push({ start: i, end, kind: "comment", runs: false });
      i = end;
      continue;
    }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      OPENER.lastIndex = i;
      const m = OPENER.exec(command);
      if (m) {
        const raw = m[2] ?? "";
        // Quoting is removed as the shell removes it: `'E"OF'` means `E"OF`, `\EOF` and `E\OF` mean `EOF`.
        const delimiter = raw.replace(
          /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g,
          (_m, single?: string, double?: string, escaped?: string) =>
            single ?? double?.replace(/\\(.)/g, "$1") ?? escaped ?? "",
        );
        if (delimiter) pending.push({ delimiter, tabs: m[1] === "-", quoted: /["'\\]/.test(raw) });
        i += m[0].length;
        wordStart = false;
        continue;
      }
    }
    wordStart = /[\s;&|()]/.test(c ?? "");
    i++;
  }
  return spans;
}

/** The heredoc bodies only, as `{ start, end }` of their text. */
export function heredocBodies(command: string): { start: number; end: number }[] {
  return quotedSpans(command).flatMap((s) => (s.body ? [s.body] : []));
}

/**
 * The command with quoted text and heredocs blanked, so operators inside them don't count. Double-quoted text
 * that runs `$(…)` or a backtick is kept: what it runs is a command.
 */
export function blankQuoted(command: string): string {
  let out = "";
  let at = 0;
  for (const span of quotedSpans(command)) {
    if (span.kind === "double" && span.runs) continue;
    out += `${command.slice(at, span.start)} `;
    at = span.end;
  }
  return out + command.slice(at);
}

/** For each position in the command, whether it sits inside quoted text or a heredoc body. */
export function quotedMask(command: string): boolean[] {
  const mask = new Array<boolean>(command.length).fill(false);
  for (const span of quotedSpans(command)) mask.fill(true, span.start, span.end);
  return mask;
}

/**
 * The text as the shell joins its words: quote marks gone, so `"pla""nted"`, `'pla'+'nted'` (PowerShell)
 * and `"--force"` read as `planted` and `--force`. For finding words and flags, never for reading paths.
 */
export function joinedWords(text: string): string {
  return text.replace(/(["'])\s*\+\s*(["'])/g, "").replace(/["'`]/g, "");
}

/** One simple command in a command line: its text and where it starts. */
export interface Step {
  start: number;
  text: string;
}

/**
 * The parts of the text between `|`, `;`, `&` and new lines, quoting ignored, each with its offset. Tests that
 * look for two words in one part (`git` then `push`) run on these, one part at a time, so their cost stays
 * linear: the same test as one pattern over the whole text backtracks once for every `git` (AUD-M4).
 */
export function segments(text: string): Step[] {
  const parts: Step[] = [];
  let start = 0;
  for (const m of text.matchAll(/[|;&\n]/g)) {
    if (m.index > start) parts.push({ start, text: text.slice(start, m.index) });
    start = m.index + 1;
  }
  if (start < text.length) parts.push({ start, text: text.slice(start) });
  return parts;
}

/** Each part that runs git, from its first `git` word to the part's end, whose rest matches `verb`. */
export function gitSteps(text: string, verb: RegExp): Step[] {
  return segments(text).flatMap((part) => {
    const at = /\bgit\b/.exec(part.text)?.index;
    if (at === undefined) return [];
    const step = { start: part.start + at, text: part.text.slice(at) };
    return verb.test(step.text) ? [step] : [];
  });
}

/** A command substitution: where it starts (`$(` or a backtick) and the command inside it. */
export interface Substitution {
  start: number;
  inner: string;
}

/**
 * Every outermost command substitution the shell would run: `$(…)` (bash and PowerShell), and a backtick
 * pair when `backticks` is set (bash; to PowerShell a backtick is an escape). Single-quoted text, comments and
 * heredoc bodies with a quoted delimiter are literal, so nothing in them runs. One pass with a stack, so
 * nested or unclosed openers cost nothing extra; an unclosed one runs to the end of the command.
 */
export function substitutions(command: string, backticks: boolean): Substitution[] {
  const literal = new Array<boolean>(command.length).fill(false);
  for (const span of quotedSpans(command)) {
    if (span.kind === "single" || span.kind === "comment") literal.fill(true, span.start, span.end);
    if (span.kind === "heredoc" && !span.runs && span.body) literal.fill(true, span.body.start, span.body.end);
  }
  const found: Substitution[] = [];
  const open: number[] = [];
  let depth = 0;
  let tick = -1;
  for (let i = 0; i < command.length; i++) {
    if (literal[i]) continue;
    const c = command[i];
    if (c === "\\" && backticks) {
      i++;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      open.push(i);
      depth++;
      i++;
    } else if (c === "(" && open.length) {
      open.push(-1);
    } else if (c === ")" && open.length) {
      const start = open.pop() ?? -1;
      if (start >= 0) depth--;
      if (start >= 0 && depth === 0) found.push({ start, inner: command.slice(start + 2, i) });
    } else if (c === "`" && backticks && !open.length) {
      if (tick < 0) tick = i;
      else {
        found.push({ start: tick, inner: command.slice(tick + 1, i) });
        tick = -1;
      }
    }
  }
  const outer = open.find((s) => s >= 0);
  if (outer !== undefined) found.push({ start: outer, inner: command.slice(outer + 2) });
  if (tick >= 0) found.push({ start: tick, inner: command.slice(tick + 1) });
  return found;
}

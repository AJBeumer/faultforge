/**
 * Spellings the shell reads as something else (re-grade after round 4): a word split by empty quotes (`g''h`),
 * an escaped letter (`\gh`), an empty `${x}` between two halves, and ANSI-C quoting (`$'pla\x6eted'`). The
 * hooks' rules look for words, so they read the command these ways too, beside the text as written. Both
 * hooks use these; neither trusts one reading alone.
 */

/** One `\…` escape inside `$'…'`, decoded as bash does. */
function ansiEscape(_m: string, body: string): string {
  const c = body[0] ?? "";
  const simple: Record<string, string> = {
    a: "\x07",
    b: "\b",
    e: "\x1b",
    E: "\x1b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "?": "?",
  };
  if (c in simple) return simple[c] ?? "";
  const code = (digits: string, radix: number) => {
    const n = Number.parseInt(digits, radix);
    return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  };
  if (c === "x") return code(body.slice(1), 16);
  if (c === "u" || c === "U") return code(body.slice(1), 16);
  if (/[0-7]/.test(c)) return code(body, 8);
  if (c === "c") return String.fromCharCode((body.charCodeAt(1) || 64) & 31);
  return `\\${body}`;
}

/**
 * The command with every `$'…'` string replaced by a single-quoted string of what bash makes of it:
 * `$'pla\x6eted'` reads `'planted'`. A single quote in the result is written the shell's way (`'\''`), so the
 * rest of the command still parses as before. Text outside `$'…'` is left as it is.
 */
export function decodeAnsiC(command: string): string {
  if (!command.includes("$'")) return command;
  return command.replace(/\$'((?:\\.|[^'\\])*)'/gs, (_m, inner: string) => {
    const text = inner.replace(
      /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/gs,
      ansiEscape,
    );
    return `'${text.replace(/'/g, "'\\''")}'`;
  });
}

/**
 * The command as the words it runs, for rules that look for a program or a word: ANSI-C strings decoded,
 * `${…}` dropped (an unset or empty variable between two halves joins them: `g${x}h`), a backslash before a
 * letter, digit or dash dropped (`\gh`), and quote marks removed (`g''h`, `"pr" merge`). Never for reading
 * paths or posted text: it is a reading for finding words, which fails closed.
 */
export function spokenWords(command: string): string {
  return decodeAnsiC(command)
    .replace(/\$\{[^}\n]*\}/g, "")
    .replace(/\\(?=[\w-])/g, "")
    .replace(/(["'])\s*\+\s*(["'])/g, "")
    .replace(/["'`]/g, "");
}

/**
 * The words with a program's punctuation read as spaces: `execFileSync('g'+'h',['pr','merge'])` reads
 * `execFileSync gh pr merge`, so a command a program would run is found by the same rules as one typed.
 */
export function codeAsWords(command: string): string {
  return spokenWords(command).replace(/[,()[\]{}]+/g, " ");
}

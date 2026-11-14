/**
 * Code a command runs that no text rule can read before it runs (second re-grade after round 4), shared by the
 * guard and the factory policy:
 *  - text built or read at run time and run as shell code: a decoder's output piped into a shell
 *    (`… | base64 -d | bash`), a substitution or a variable handed to `bash -c`, `sh -c`, `cmd /c`, `eval`,
 *    `iex` or `source <(…)`, and a substitution or a variable run as the command itself (`$(…)`). Only a literal
 *    the hooks can read may be run that way (`bash -c 'npm test'`, `echo 'ls' | sh`);
 *  - inline code in an interpreter (`node -e`, `python -c`, `perl -e`, `ruby -e`, a heredoc fed to one) that
 *    makes a network call: it can post to a reviewed repo without gh, where the guard reads nothing.
 * Both are refused outright: a decoder can be anything (`base64 -d`, `xxd -r`, `rev`, `openssl enc -d`,
 * `printf '\x..'`), so the rule is about where the text goes, not how it was made.
 */
import { decodeAnsiC, spokenWords } from "./shell-decode.ts";
import { quotedSpans, substitutions } from "./shell-scan.ts";

/** The denial for text run as shell code. It never quotes the command, which could hold a private id. */
export const BUILT_CODE_REASON =
  "This command runs text it builds or reads at run time as shell code: a decoded string, a substitution or a variable piped or passed to a shell, eval or source, or run as the command. No hook can read that code before it runs. Run the command itself, written out.";

/** The denial for inline interpreter code that makes a network call. */
export const INLINE_NETWORK_REASON =
  "This command runs inline code (node -e, python -c, perl -e, ruby -e, or code fed on stdin) that makes a network call. It could post anywhere without gh, where the guard can read the text. Use gh for GitHub; only the app on localhost may be reached from code.";

/** Programs that run their input as shell code. */
const SHELLS = /^(bash|sh|zsh|dash|ksh|mksh|ash|fish|pwsh|powershell|cmd)$/i;
/** Builtins that run their arguments, or a file they name, as shell code. */
const EVALS = /^(eval|iex|invoke-expression)$/i;
const SOURCES = /^(source|\.)$/i;
/** Words that run the next word as the program. `xargs` also feeds it its own input. */
const PREFIXES =
  /^(sudo|doas|env|exec|command|builtin|nohup|time|nice|stdbuf|timeout|setsid|ionice|taskset|xargs|wsl|busybox|npx|pnpx|bunx|!|\(|\{)$/i;
/** Language interpreters whose inline code can make a network call. */
const INTERPRETERS = /^(node|nodejs|deno|bun|tsx|ts-node|python\d*(\.\d+)?|py|perl|ruby|irb|php)$/i;

/**
 * Network calls from code (#243; perl and ruby added): `fetch(`, Node's `http.request` and its modules,
 * Python's `urllib`, `requests`, `http.client` and `socket`, Perl's LWP, HTTP::Tiny and IO::Socket, Ruby's
 * `net/http`, `open-uri` and TCPSocket, PHP's curl and sockets, a browser-style request or socket.
 */
export const NETWORK_CODE = new RegExp(
  [
    String.raw`\bfetch\s*\(`,
    String.raw`\bhttps?\s*\.\s*(request|get)\s*\(`,
    String.raw`\b(require|import)\s*\(\s*["'\x60]?(node:)?(https?|net|tls|dgram|undici)\b`,
    String.raw`\bfrom\s+["'\x60](node:)?(https?|net|tls|dgram|undici)["'\x60]`,
    String.raw`\bnet\s*\.\s*(connect|createConnection)\b`,
    String.raw`\burllib\b|\bhttp\.client\b`,
    String.raw`\brequests\s*\.\s*(get|post|put|patch|delete|head|request|Session)\b`,
    String.raw`\bimport\s+(requests|socket|httpx|aiohttp)\b`,
    String.raw`\bfrom\s+(requests|socket|httpx|aiohttp|urllib[\w.]*|http\.client)\s+import\b`,
    String.raw`\bsocket\s*\.\s*(socket|create_connection)\b`,
    String.raw`\b(require|import)\s*\(\s*["'\x60](axios|node-fetch|got|superagent|ky|needle)["'\x60]`,
    String.raw`\bfrom\s+["'\x60](axios|node-fetch|got|superagent|ky|needle)["'\x60]`,
    String.raw`\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bDeno\s*\.\s*connect\b`,
    String.raw`\bLWP\b|\bHTTP::Tiny\b|\bIO::Socket\b|\bNet::HTTP\b|\bHTTP::Request\b|\buse\s+Socket\b|-MSocket\b`,
    String.raw`\bnet/http\b|\bopen-uri\b|\bURI\s*\.\s*open\b|\bTCPSocket\b|\bSocket\s*\.\s*tcp\b|-rsocket\b`,
    String.raw`\bcurl_init\b|\bfsockopen\b|\bstream_socket_client\b|\bfile_get_contents\s*\(\s*["']https?:`,
  ].join("|"),
);

/** Hosts code may reach: only the app a run starts for a live check. */
export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * True when every network call in `text` names a local URL of its own: at least one URL, none of them
 * elsewhere, and no more calls than URLs (one localhost URL beside a call whose address is built at run time
 * vouches for nothing; Qodo on PR 270).
 */
export function onlyLocalCalls(text: string, calls: number): boolean {
  const hosts = [...text.matchAll(/\b(?:https?|ftp|wss?):\/\/([^/\s:'"`]+|\[[^\]]+\])/gi)].map((m) =>
    (m[1] ?? "").toLowerCase(),
  );
  return hosts.length > 0 && hosts.every((h) => LOCAL_HOSTS.has(h)) && calls <= hosts.length;
}

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

/** One simple command: its text, and whether a pipe feeds it the output of the step before. */
interface Step {
  text: string;
  piped: boolean;
}

/**
 * The command's simple commands, split at `|`, `||`, `&&`, `;`, `&` and new lines outside quotes, substitutions
 * and heredoc bodies (a heredoc's body stays with the command it feeds). `backticks` is bash's reading; to
 * PowerShell a backtick escapes the next character.
 */
function steps(command: string, backticks: boolean): Step[] {
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
function words(step: string): string[] {
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

/** The text with single-quoted parts blanked: what is left is what the shell expands. */
const expanding = (text: string) => text.replace(/'[^']*'/g, "''");

/** True when the shell builds part of the text at run time: a substitution, a backtick, a variable. */
const BUILT = /\$\(|`|\$\{?[A-Za-z_]|<\(|%[A-Za-z_]\w*%/;

/** A program's name as a word: quotes and escapes removed, its folder and `.exe` dropped. */
function programName(word: string): string {
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
function programAt(all: string[]): { at: number; xargs: boolean } {
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
 * Each pipeline of the command that runs a language interpreter, as one text (its code may come from a step
 * that pipes it in, or from a heredoc), or none.
 */
export function interpreterPipelines(command: string, backticks = true): string[] {
  const pipelines: Step[][] = [];
  for (const step of steps(command, backticks)) {
    const last = pipelines[pipelines.length - 1];
    if (step.piped && last) last.push(step);
    else pipelines.push([step]);
  }
  return pipelines
    .filter((pipeline) =>
      pipeline.some((step) => {
        const all = words(step.text);
        return INTERPRETERS.test(programName(all[programAt(all).at] ?? ""));
      }),
    )
    .map((pipeline) => pipeline.map((step) => step.text).join(" | "));
}

/** Why the command may not run because inline interpreter code in it makes a network call, or undefined. */
export function inlineNetworkProblem(command: string, backticks = true): string | undefined {
  for (const text of new Set([command, decodeAnsiC(command)])) {
    for (const code of interpreterPipelines(text, backticks)) {
      const calls = [...code.matchAll(new RegExp(NETWORK_CODE.source, "g"))].length;
      if (calls && !onlyLocalCalls(code, calls)) return INLINE_NETWORK_REASON;
    }
  }
  return undefined;
}

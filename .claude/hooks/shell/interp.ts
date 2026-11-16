/**
 * Inline code in a language interpreter (`node -e`, `python -c`, `perl -e`, a heredoc or a pipe into one that
 * reads its code from stdin), shared by the guard and the factory policy: what that code is, whether it starts
 * another program or runs code it builds, and whether it makes a network call. Split out of shell/exec.ts.
 *
 * Only the code an interpreter is handed counts (Qodo on PR 310): a script's path and its arguments are not code,
 * and neither is the text of another step in the pipeline, unless that step pipes the code in.
 */
import { decodeAnsiC, spokenWords } from "./decode.ts";
import { programAt, programName, type Step, steps, words } from "./words.ts";

/** The denial for inline interpreter code that makes a network call. */
export const INLINE_NETWORK_REASON =
  "This command runs inline code (node -e, python -c, perl -e, ruby -e, or code fed on stdin) that makes a network call. It could post anywhere without gh, where the guard can read the text. Use gh for GitHub; only the app on localhost may be reached from code.";

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

/**
 * Network calls in inline code: as `NETWORK_CODE`, and `fetch` named at all, called or not, since code can call
 * it under another name (`const f = fetch; f(url)`; Qodo on PR 310). Only for inline code: in a whole command,
 * `git fetch` is no network call from code.
 */
const INLINE_NETWORK_CODE = new RegExp(`${String.raw`\bfetch\b`}|${NETWORK_CODE.source}`);

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

/**
 * Code in a language interpreter that starts another program, or runs code it builds (re-grade 3): no hook reads
 * what that program is. One pattern per family, chosen by the interpreter's name, so a template literal in
 * `node -e` or a regex's `.exec(` isn't taken for Perl's backticks or a shell call. A global reached as a value
 * (`Reflect.get(globalThis, …)`, `Object.values(globalThis)`) and an escape in a name (`fetch`) are code
 * that names its function at run time too (Qodo on PR 310).
 */
const SUBPROCESS_CODE: [interpreter: RegExp, code: RegExp][] = [
  [
    /^(node|nodejs|deno|bun|tsx|ts-node)$/,
    new RegExp(
      [
        String.raw`\bchild_process\b|\bworker_threads\b|["'\x60](node:)?vm["'\x60]`,
        String.raw`\b(eval|Function)\s*\(|\bnew\s+Function\b`,
        // A module named by anything but one literal: `require('child_' + 'process')`, `import(x)`, and a template
        // literal that builds part of its name (`child_${x}`; #318). A file path (`'./' + f`) is blanked first.
        String.raw`\b(require|import|getBuiltinModule)\s*\(\s*(?!["'][^"'+]*["']\s*\)|\x60[^\x60$+]*\x60\s*\))`,
        String.raw`\b(globalThis|global|process|module|self|window)\s*\[`,
        String.raw`\bprocess\s*\.\s*(binding|_linkedBinding|dlopen)\b|\bBun\s*\.\s*(spawn\w*|\$)|\bDeno\s*\.\s*(run|Command)\b`,
        // An escape in a name (`fetch`) is read decoded instead (`jsUnescaped`; #318).
        String.raw`\bReflect\b|\bgetOwnPropertyDescriptors?\b|\bwith\s*\(`,
        String.raw`\b(globalThis|global|self|window)\b(?!\s*\.)`,
      ].join("|"),
    ),
  ],
  [
    /^(python\d*(\.\d+)?|py)$/,
    /\bos\s*\.\s*(system|popen|exec\w*|spawn\w*|fork\w*|posix_spawn\w*)\b|\bsubprocess\b|\bpty\b|\bfrom\s+os\s+import\b|\b(exec|eval|compile|getattr|__import__|globals|vars)\s*\(|\bimportlib\b|\bctypes\b|\bmultiprocessing\b|\b__builtins__\b|\bbuiltins\b/,
  ],
  [/^perl$/, /\b(system|exec|qx|readpipe|eval|fork)\b|`|\bopen\b[^;]*\||\bIPC::/],
  [
    /^(ruby|irb)$/,
    /\b(system|exec|spawn|fork|eval|\w*_eval|send|public_send|__send__)\b|`|%x[{([<|!]|\bIO\s*\.\s*popen\b|\bOpen3\b|\bKernel\b|\bPTY\b/,
  ],
  [
    /^php$/,
    /\b(shell_exec|exec|system|passthru|popen|proc_open|pcntl_exec|eval|assert|create_function|call_user_func\w*)\s*\(|`/,
  ],
];

/**
 * How each interpreter family is told what to run: the flags that hand it code inline, the flags whose value is
 * the next word, the flags that name a module or a script to run instead (`python -m`, `php -f`), and the
 * subcommands that come before a script (`deno run`, `tsx watch`). `deno eval` takes its code as a subcommand.
 */
interface Family {
  names: RegExp;
  inline: RegExp;
  valued: RegExp;
  runs?: RegExp;
  subcommands?: RegExp;
}
const FAMILIES: Family[] = [
  {
    names: /^(node|nodejs|tsx|ts-node|bun|deno)$/,
    inline: /^(-[a-zA-Z]*[ep]|--eval|--print|eval)$|^--(eval|print)=/,
    valued:
      /^(-r|--require|--import|--loader|--experimental-loader|-C|--conditions|--env-file|--tsconfig|-P|--project|--input-type|--title|--cwd)$/,
    subcommands: /^(run|watch|test|x|exec)$/,
  },
  { names: /^(python\d*(\.\d+)?|py)$/, inline: /^-[a-zA-Z]*c/, valued: /^-[WXQ]$/, runs: /^-[a-zA-Z]*m/ },
  { names: /^perl$/, inline: /^-[a-zA-Z]*[eE]/, valued: /^-[IMx]$/ },
  { names: /^(ruby|irb)$/, inline: /^-[a-zA-Z]*e/, valued: /^-[rICE]$/ },
  { names: /^php$/, inline: /^-[a-zA-Z]*[rRBE]/, valued: /^-[cdz]$/, runs: /^-f$/ },
];

/**
 * The code one interpreter step runs, or "" when it runs a script or a module: then only its own flags count
 * (`perl -MSocket x.pl`). Code given inline is the whole step (its arguments may reach the code); code read from
 * stdin (no script, `-`, a heredoc or a redirect) is the step with every step that pipes into it.
 */
function stepCode(step: Step, before: Step[], name: string): string {
  const family = FAMILIES.find((f) => f.names.test(name));
  // A heredoc's body is after the first line; only that line holds the step's words.
  const all = words(step.text.split("\n")[0] ?? "");
  const at = programAt(all).at;
  let script: number | undefined;
  for (let i = at + 1; i < all.length && family; i++) {
    const word = spokenWords(all[i] ?? "");
    // A process substitution is a file whose text a program writes: as good as code from stdin.
    if (/^[<>]\(/.test(all[i] ?? "")) break;
    if (/^\d*(<|>|&>)/.test(word)) {
      // A redirect: its file is the next word when the operator stands alone.
      if (/^\d*(<{1,3}|>{1,2}|&>{1,2})$/.test(word)) i++;
      continue;
    }
    // Code handed over as a flag's value (`--import data:…`) is inline code too (Qodo on PR 312).
    if (family.inline.test(word) || /(^|=)data:/.test(word)) return step.text;
    if (word === "-") break;
    // A module that runs the code it is given or reads it from stdin (`-m timeit`, `-m code`; Qodo on PR 312).
    const module = family.runs?.test(word) ? word.replace(/^-[a-zA-Z]*m/, "") || spokenWords(all[i + 1] ?? "") : "";
    if (CODE_MODULES.test(module)) break;
    if (word === "--" || family.runs?.test(word)) {
      script = i;
      break;
    }
    if (word.startsWith("-")) {
      if (family.valued.test(word)) i++;
      continue;
    }
    if (i === at + 1 && family.subcommands?.test(word)) continue;
    script = i;
    break;
  }
  // A script that is stdin by another name (`/dev/stdin`, `/dev/fd/0`) or a path built at run time is no file
  // to read: its code is what is fed in, as with no script at all (Qodo on PR 312).
  const named = all[script !== undefined && /^--$/.test(all[script] ?? "") ? script + 1 : (script ?? -1)] ?? "";
  // A "script" that is itself an interpreter's name follows a prefix's value (`npx --package tsx tsx -e …`): that
  // second one is the program, so the whole step is read (Qodo on PR 312, fourth review).
  const second = INTERPRETERS.test(programName(named));
  // A flag can take its value as the next word without being listed (`--inspect-port 9229`), so that value may
  // look like the script. An inline-code flag anywhere after it means the step is read whole, with what is piped
  // into it, as with a script that reads stdin (Qodo on PRs 312 and 313). A script's own argument that only looks
  // like such a flag gets the wider reading main had before PR 312: it can refuse more, never less.
  const later = all
    .slice((script ?? all.length) + 1)
    .some((w) => family?.inline.test(spokenWords(w)) || /(^|=)data:/.test(spokenWords(w)));
  if (later) return [...before.map((s) => s.text), step.text].join(" | ");
  if (script !== undefined && !second && !STDIN_SCRIPT.test(named.replace(/["']/g, "")))
    return all.slice(at, script).join(" ");
  return [...before.map((s) => s.text), step.text].join(" | ");
}

/** A script path that reads stdin or a program's output, or that the shell builds at run time. */
const STDIN_SCRIPT = /^(\/dev\/(stdin|fd\/\d+)|\/proc\/(self|\d+)\/fd\/\d+)$|^[<>]\(|[$`]/;

/** Python's modules that run code given as an argument or on stdin. */
const CODE_MODULES = /^(timeit|code|runpy|cProfile|profile|trace|pdb|doctest|asyncio|idlelib|IPython|ipython)$/;

/** Variables that hand an interpreter code or options from outside its command line. */
const OPTION_VARIABLES =
  /\b(NODE_OPTIONS|NODE_PATH|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PYTHONINSPECT|PHP_INI_SCAN_DIR)\b/;

/**
 * Each interpreter the command runs, by name, with the code it runs (`stepCode`). A command that sets a
 * variable an interpreter reads its options or startup code from (`NODE_OPTIONS='--import=data:…'`) hands it
 * code outside its own words: then the whole command is that interpreter's code (Qodo on PR 312).
 */
function interpreterRuns(command: string, backticks: boolean): { name: string; code: string }[] {
  const options = OPTION_VARIABLES.test(command);
  const pipelines: Step[][] = [];
  for (const step of steps(command, backticks)) {
    const last = pipelines[pipelines.length - 1];
    if (step.piped && last) last.push(step);
    else pipelines.push([step]);
  }
  // With an option variable, the code is the command up to and including the interpreter's step: a step after it
  // can't hand it code (Qodo on PR 312, fourth review).
  let from = 0;
  return pipelines.flatMap((pipeline) =>
    pipeline.flatMap((step, i) => {
      const found = command.indexOf(step.text, from);
      if (found >= 0) from = found + step.text.length;
      const all = words(step.text.split("\n")[0] ?? "");
      const name = programName(all[programAt(all).at] ?? "");
      if (!INTERPRETERS.test(name)) return [];
      return [
        {
          name,
          code: options
            ? command.slice(0, found >= 0 ? from : command.length)
            : stepCode(step, pipeline.slice(0, i), name),
        },
      ];
    }),
  );
}

/**
 * Code's escapes decoded, as JavaScript reads them in names and strings: `t`, `\u{74}`, `\x74`, and octal
 * `\164`. Read beside the code as written, and again with the shell's `\\` taken as one backslash, so a name
 * spelled with an escape (`fetch`, `'child\x5fprocess'`) is the name it spells (#318).
 */
export function codeReadings(code: string): string[] {
  const decode = (text: string) =>
    text
      .replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (whole, braced, four, two) => {
        const point = Number.parseInt(braced ?? four ?? two, 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
      })
      .replace(/\\([0-7]{1,3})/g, (_whole, octal) => String.fromCharCode(Number.parseInt(octal, 8) & 0xff));
  return [...new Set([code, decode(code), decode(code.replace(/\\\\/g, "\\"))])];
}

/** The start of a file path in a module name: `./`, `../`, `/` or a drive. A path is never a builtin module. */
const PATH_START = String.raw`(?:\.{1,2}\/|\/|[A-Za-z]:\/)`;

/**
 * A string literal as JavaScript reads it: closed by the quote that opened it, never the other kind (Qodo on PR
 * 323). One with a backslash is not taken at all, so no escape can move where it ends.
 */
const literal = (start = "") => String.raw`(?:'${start}[^'\n\\]*'|"${start}[^"\n\\]*")`;

/**
 * `require` or `import()` of a file path built from a literal path and plain names (#318): `require('./' + f)`,
 * `require('../d/' + f + '.json')`, `` require(`./${f}`) ``. Whatever the names hold, the result starts with the
 * path, so it can't name a builtin such as child_process. A call, an operator other than `+`, or code in a
 * template's `${…}` is no plain name, so it is not taken. Paths use forward slashes: a backslash is an escape.
 */
const PATH_REQUIRE = new RegExp(
  String.raw`\b(?:require|import)\s*\(\s*(?:${literal(PATH_START)}(?:\s*\+\s*(?:[\w$]+(?:\.[\w$]+)*|${literal()}))*|\x60${PATH_START}(?:[^\x60$\\]|\$\{\s*[\w$]+(?:\.[\w$]+)*\s*\})*\x60)\s*\)`,
  "g",
);

/** True when inline code in a language interpreter starts a program or runs code it builds. */
export function subprocessCode(command: string, backticks: boolean): boolean {
  return interpreterRuns(command, backticks).some(({ name, code }) =>
    SUBPROCESS_CODE.some(
      ([interpreter, pattern]) =>
        interpreter.test(name) &&
        codeReadings(code).some((text) => pattern.test(text.replace(PATH_REQUIRE, "require('./file')"))),
    ),
  );
}

/** The code each interpreter the command runs is handed (`stepCode`), once each, or none. */
export function interpreterPipelines(command: string, backticks = true): string[] {
  return [...new Set(interpreterRuns(command, backticks).map((run) => run.code))].filter(Boolean);
}

/** Why the command may not run because inline interpreter code in it makes a network call, or undefined. */
export function inlineNetworkProblem(command: string, backticks = true): string | undefined {
  for (const text of new Set([command, decodeAnsiC(command)])) {
    for (const code of interpreterPipelines(text, backticks).flatMap(codeReadings)) {
      const calls = [...code.matchAll(new RegExp(INLINE_NETWORK_CODE.source, "g"))].length;
      if (calls && !onlyLocalCalls(code, calls)) return INLINE_NETWORK_REASON;
    }
  }
  return undefined;
}

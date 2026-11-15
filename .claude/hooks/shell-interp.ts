/**
 * Inline code in a language interpreter (`node -e`, `python -c`, `perl -e`, a heredoc or a pipe into one that
 * reads its code from stdin), shared by the guard and the factory policy: what that code is, whether it starts
 * another program or runs code it builds, and whether it makes a network call. Split out of shell-exec.ts.
 *
 * Only the code an interpreter is handed counts (Qodo on PR 310): a script's path and its arguments are not code,
 * and neither is the text of another step in the pipeline, unless that step pipes the code in.
 */
import { decodeAnsiC, spokenWords } from "./shell-decode.ts";
import { programAt, programName, type Step, steps, words } from "./shell-words.ts";

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
        // A module named by anything but one literal: `require('child_' + 'process')`, `import(x)`.
        String.raw`\b(require|import|getBuiltinModule)\s*\(\s*(?!["'\x60][^"'\x60+]*["'\x60]\s*\))`,
        String.raw`\b(globalThis|global|process|module|self|window)\s*\[`,
        String.raw`\bprocess\s*\.\s*(binding|_linkedBinding|dlopen)\b|\bBun\s*\.\s*(spawn\w*|\$)|\bDeno\s*\.\s*(run|Command)\b`,
        String.raw`\bReflect\b|\bgetOwnPropertyDescriptors?\b|\bwith\s*\(|\\u\{?[0-9a-fA-F]`,
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
    if (family.inline.test(word)) return step.text;
    if (word === "-") break;
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
  if (script !== undefined && !STDIN_SCRIPT.test(named.replace(/["']/g, ""))) return all.slice(at, script).join(" ");
  return [...before.map((s) => s.text), step.text].join(" | ");
}

/** A script path that reads stdin or a program's output, or that the shell builds at run time. */
const STDIN_SCRIPT = /^(\/dev\/(stdin|fd\/\d+)|\/proc\/(self|\d+)\/fd\/\d+)$|^[<>]\(|[$`]/;

/** Each interpreter the command runs, by name, with the code it runs (`stepCode`). */
function interpreterRuns(command: string, backticks: boolean): { name: string; code: string }[] {
  const pipelines: Step[][] = [];
  for (const step of steps(command, backticks)) {
    const last = pipelines[pipelines.length - 1];
    if (step.piped && last) last.push(step);
    else pipelines.push([step]);
  }
  return pipelines.flatMap((pipeline) =>
    pipeline.flatMap((step, i) => {
      const all = words(step.text.split("\n")[0] ?? "");
      const name = programName(all[programAt(all).at] ?? "");
      return INTERPRETERS.test(name) ? [{ name, code: stepCode(step, pipeline.slice(0, i), name) }] : [];
    }),
  );
}

/** True when inline code in a language interpreter starts a program or runs code it builds. */
export function subprocessCode(command: string, backticks: boolean): boolean {
  return interpreterRuns(command, backticks).some(({ name, code }) =>
    SUBPROCESS_CODE.some(([interpreter, pattern]) => interpreter.test(name) && pattern.test(code)),
  );
}

/** The code each interpreter the command runs is handed (`stepCode`), once each, or none. */
export function interpreterPipelines(command: string, backticks = true): string[] {
  return [...new Set(interpreterRuns(command, backticks).map((run) => run.code))].filter(Boolean);
}

/** Why the command may not run because inline interpreter code in it makes a network call, or undefined. */
export function inlineNetworkProblem(command: string, backticks = true): string | undefined {
  for (const text of new Set([command, decodeAnsiC(command)])) {
    for (const code of interpreterPipelines(text, backticks)) {
      const calls = [...code.matchAll(new RegExp(INLINE_NETWORK_CODE.source, "g"))].length;
      if (calls && !onlyLocalCalls(code, calls)) return INLINE_NETWORK_REASON;
    }
  }
  return undefined;
}

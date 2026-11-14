/**
 * The factory policy's rules about files (AUD-H2, re-grade after round 4): what a run may not read (the
 * process files under `/proc`, the answer key, and in a target ticket's run the private checkouts), which files
 * a shell command may not write (the guardrails: `.claude/` and the giveaway word list), and which scripts it
 * may not run (one this run wrote or changed, which no text rule can read before it runs). Split from
 * factory-policy.ts, which may not pass 400 lines.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { codeAsWords, spokenWords } from "./shell-decode.ts";
import { quotedMask } from "./shell-scan.ts";

/** The runner's list of private checkouts a target ticket's run must not read, as the agent's environment holds it. */
export const PRIVATE_CHECKOUTS_ENV = "FAULTFORGE_PRIVATE_CHECKOUTS";

/** The commits each of the run's repos started from, comma-separated: a script that runs must match one. */
export const RUN_BASES_ENV = "FAULTFORGE_RUN_BASES";

/** The private repo's own files by name: the answer key, the audit log, the backlog and the templates. */
const PRIVATE_NAMES = /ground[-_]?truth|audit[-_]events|BACKLOG\.md|private[/\\]+(templates|config|cases)\b/i;

/**
 * The private files no run reads, a lab ticket's included, by their path in the private checkout: the answer
 * key, the audit log and the unreleased templates. A lab ticket's agent saves evidence there, never reads these.
 */
const ANSWER_FILES = /private[/\\]+(ground-truth\.jsonl|audit-events\.jsonl|templates\b|cases\b)/i;

/** Anything under `/proc`: a process's environment, memory and files, its own (`self`) or another's. */
const PROC = /(^|[^\w.-])\/proc(\/|$)/i;

/** The guardrails a shell command may not write: anything under `.claude`, and the giveaway word list. */
const GUARDRAILS = /(?<![\w-])\.claude(?![\w-])|\bneutral\.ts\b/i;

/** Redirects that write no file: to another descriptor or to the null device. */
const HARMLESS_REDIRECT = /\d?>&\d|\d?>\s*\/dev\/null|\d?>\s*nul\b/gi;

/** Ways a shell command writes a file: a redirect, a file tool, an in-place edit, a write from code, or git. */
const SHELL_WRITE = new RegExp(
  [
    ">",
    String.raw`\b(cp|mv|tee|rm|rmdir|unlink|ln|install|rsync|truncate|dd|touch|chmod|chown|patch)\b`,
    String.raw`\b(Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|New-Item|Rename-Item|Clear-Content)\b`,
    String.raw`\bsed\b[^|;&\n]*\s(-[a-zA-Z]*i|--in-place)`,
    String.raw`\bperl\b[^|;&\n]*\s-[a-zA-Z]*i`,
    String.raw`\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|cpSync|rename|renameSync|rmSync|unlink|unlinkSync|truncateSync|openSync|symlink|symlinkSync|write_text|write_bytes|shutil)\b`,
    String.raw`\bopen\s*\([^)]*["'][wa]`,
    String.raw`\bgit\b[^|;&\n]*\b(checkout|restore|apply|am|stash|reset|clean|mv|rm|switch|merge|pull|rebase|cherry-pick)\b`,
  ].join("|"),
  "i",
);

/** True when `path` is `folder` or inside it, compared as the file system does on this platform. */
function inside(path: string, folder: string): boolean {
  const rel = relative(resolve(folder), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The real path of `path`, through links, or its plain resolved form when it doesn't exist. */
function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** The private checkouts named in the run's environment: none in a lab ticket's run. */
export function privateCheckouts(env: NodeJS.ProcessEnv): string[] {
  return (env[PRIVATE_CHECKOUTS_ENV] ?? "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
}

/** A path's spellings as a command could write it: native, forward slashes, lower case, `/d/…`. */
function spellings(path: string): string[] {
  const forward = path.replace(/\\/g, "/").toLowerCase();
  return [...new Set([forward, forward.replace(/^([a-z]):/, "/$1")])];
}

/** A text as forward-slashed, collapsed path text, so `/proc/./self` and `/proc//self` read `/proc/self`. */
const asPath = (text: string) => posix.normalize(text.replace(/\\/g, "/"));

/** The fixed folder a glob pattern starts from: everything before its first wildcard. */
const globBase = (pattern: string) => pattern.split(/[*?[{]/)[0]?.replace(/[^/\\]*$/, "") ?? "";

/**
 * Why a read tool (Read, Grep, Glob) may not read what it names, or undefined: anything under `/proc` and the
 * answer key in any run, and in a target ticket's run a private checkout, a folder that holds one, or a
 * private file by name (#284). The run's own folder is its own, even inside a folder the runner names.
 */
export function readViolation(args: Record<string, unknown>, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  const texts = ["file_path", "path", "pattern", "glob", "notebook_path"].map(text).filter(Boolean);
  const named = ["file_path", "path", "notebook_path"].map(text).filter(Boolean);
  const pattern = text("pattern");
  // Glob's pattern is a path too: its fixed start, from its folder (Qodo on PR 288).
  const roots = named.length ? named : [text("path") || "."];
  const paths = [...named, ...(pattern && globBase(pattern) ? [globBase(pattern)] : [])].map((p) => resolve(cwd, p));
  const all = [...new Set([...paths, ...roots.map((p) => resolve(cwd, p))])];
  const resolved = all.flatMap((p) => [p, real(p)]);
  if ([...texts, ...resolved].some((t) => PROC.test(asPath(t)))) return "no reading process files under /proc";
  if ([...texts, ...resolved].some((t) => ANSWER_FILES.test(t)))
    return "no run reads the answer key, the audit log or the templates";
  const checkouts = privateCheckouts(env);
  if (!checkouts.length) return undefined;
  if (texts.some((t) => PRIVATE_NAMES.test(t))) return "a target ticket's run doesn't read the private repo";
  const own = env.FAULTFORGE_RUN_ROOT ? resolve(env.FAULTFORGE_RUN_ROOT) : undefined;
  for (const path of resolved) {
    if (own && inside(path, own)) continue;
    // In a checkout, or a folder that holds one (a search from a parent reads it too; Qodo on PR 288).
    if (checkouts.some((c) => inside(path, c) || inside(path, real(c)) || inside(c, path)))
      return "a target ticket's run doesn't read the private repo";
  }
  return undefined;
}

/** Why a shell command may not run because it names the private repo's files or checkouts, or undefined. */
export function privateCommandViolation(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const readings = [command, spokenWords(command)];
  if (readings.some((r) => ANSWER_FILES.test(r))) return "no run reads the answer key, the audit log or the templates";
  const checkouts = privateCheckouts(env);
  if (!checkouts.length) return undefined;
  // The run's own folder may sit inside one the runner names (its runs folder): it is set aside first.
  const own = env.FAULTFORGE_RUN_ROOT ? spellings(resolve(env.FAULTFORGE_RUN_ROOT)) : [];
  const named = (text: string) => {
    let lower = text.toLowerCase().replace(/\\/g, "/");
    for (const s of own) lower = lower.split(s).join(" ");
    return checkouts.some((c) => spellings(c).some((s) => lower.includes(s)));
  };
  if (readings.some((r) => PRIVATE_NAMES.test(r) || named(r)))
    return "a target ticket's run doesn't read or change the private repo";
  return undefined;
}

/**
 * Why a shell command may not run because it could write a guardrail file, or undefined: a write that names
 * one, a write from inside a `.claude` folder (the Bash tool keeps its folder between calls), and a write whose
 * path or text the shell builds at run time (`$(…)`, a variable), which can't be read before it runs.
 */
export function guardrailWriteViolation(command: string, cwd = ""): string | undefined {
  const readings = [command, spokenWords(command), codeAsWords(command)].map((r) => r.replace(HARMLESS_REDIRECT, " "));
  if (!readings.some((r) => SHELL_WRITE.test(r))) return undefined;
  if (readings.some((r) => GUARDRAILS.test(r)) || (cwd && /(^|[/\\])\.claude([/\\]|$)/i.test(resolve(cwd))))
    return "the agent can't change its own guardrails (.claude, neutral.ts) from the shell either";
  if (/\$\(|`|\$\{?[A-Za-z_]|<\(/.test(command))
    return "a shell write whose path the shell builds ($(…), a variable) can't be checked before it runs; write files with the Write tool";
  return undefined;
}

/** Programs that run a script file given as their first argument. */
const INTERPRETER =
  /^(node|nodejs|deno|bun|tsx|ts-node|python\d*(\.\d+)?|py|perl|ruby|php|bash|sh|zsh|dash|ksh|fish|pwsh|powershell|source|\.)$/i;
/** The shells, whose inline code is itself a command line. */
const SHELL = /^(bash|sh|zsh|dash|ksh|fish|pwsh|powershell)$/i;
/** Flags that make the interpreter run code from the command line rather than a file. */
const INLINE = /^(-e|-c|-p|-pe|-ne|--eval|--print|-Command|-EncodedCommand)$/i;
/** Flags whose value, the next word, is a file the interpreter loads before the script. */
const PRELOAD = /^(-r|--require|--import|--loader|--experimental-loader|-File)$/i;
/** Words that run the next word as a program: `timeout 5 node x.js`, `env A=b node x.js`, `xargs node`. */
const PREFIX =
  /^(sudo|env|exec|time|nice|nohup|command|stdbuf|xargs|timeout|setsid|ionice|taskset|strace|ltrace|valgrind|\(|\{)$/i;

/** The command's steps, split at `|`, `;`, `&` and new lines outside quoted text. */
function steps(command: string): string[] {
  const quoted = quotedMask(command);
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < command.length; i++) {
    if (quoted[i] || !"|;&\n".includes(command[i] ?? "")) continue;
    parts.push(command.slice(start, i));
    start = i + 1;
  }
  parts.push(command.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** One git answer in `cwd`, trimmed, or undefined when git fails. */
function gitOut(cwd: string, ...args: string[]): string | undefined {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/**
 * True when `file` is, byte for byte, a file of one of the commits the run started from (`bases`): the
 * project's own code, not one this run wrote or changed (Qodo on PR 288). A commit only the agent made, in a
 * scratch repo or by moving a ref, is not one of them. Without `bases`, its repo's `origin/main` stands in.
 */
function unchangedFromBase(file: string, bases: string[], runRoot: string | undefined): boolean {
  if (!existsSync(file)) return false;
  const top = gitOut(dirname(file), "rev-parse", "--show-toplevel");
  if (!top) return false;
  if (runRoot && !inside(real(top), real(runRoot))) return false;
  const rel = relative(real(top), real(file)).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return false;
  const now = gitOut(top, "hash-object", "--", rel);
  if (!now) return false;
  return (bases.length ? bases : ["origin/main"]).some((base) => gitOut(top, "rev-parse", `${base}:${rel}`) === now);
}

/** A script found in a command, and the folder it is read from (`undefined` when the shell builds it). */
interface Script {
  file: string;
  dir: string | undefined;
}

/**
 * The script files a command runs: an interpreter's first argument, a file it preloads or reads from stdin, a
 * relative module its inline code requires, a Python module it runs with `-m` that is a file here, a shell's
 * inline command line (read again, as a command), and a path run as a program. Each comes with the folder it is
 * read from, which follows the command's own `cd` steps.
 */
export function scriptsRun(command: string, cwd: string, depth = 0): Script[] {
  const found: Script[] = [];
  let dir: string | undefined = cwd;
  for (const step of steps(command)) {
    const words = spokenWords(step).split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      const word = words[i] ?? "";
      if (/^[A-Za-z_]\w*=/.test(word)) i++;
      else if (PREFIX.test(word)) {
        i++;
        while (i < words.length && /^(-|\d+(\.\d+)?[smhd]?$)/.test(words[i] ?? "")) i++;
      } else break;
    }
    const program = words[i] ?? "";
    if (/^(cd|pushd|Set-Location|sl)$/i.test(program)) {
      const to = words[i + 1];
      dir = to && dir && !/[$`%~]/.test(to) ? resolve(dir, to) : undefined;
      continue;
    }
    let at = i;
    let name = basename(program).replace(/\.exe$/i, "");
    if (/^(npx|pnpx|bunx)$/i.test(name) || (/^(deno|bun)$/i.test(name) && /^run$/i.test(words[i + 1] ?? ""))) {
      at++;
      while (at < words.length && (words[at] ?? "").startsWith("-")) at++;
      if (/^(deno|bun)$/i.test(name)) name = "node";
      else name = basename(words[at] ?? "");
      if (/^(npx|pnpx|bunx)$/i.test(basename(program)) && !INTERPRETER.test(name)) continue;
    }
    if (!INTERPRETER.test(name)) {
      // A path run as a program, with or without an extension; installed tools under node_modules excepted.
      if (/[/\\]/.test(program) && !/(^|[/\\])node_modules[/\\]/.test(program)) found.push({ file: program, dir });
      continue;
    }
    // A file fed on stdin: `node < x.js`.
    for (const m of step.matchAll(/(?<![<\d])<(?![<(])\s*["']?([^\s"';&|<>()]+)/g))
      found.push({ file: m[1] ?? "", dir });
    for (let j = at + 1; j < words.length; j++) {
      const word = words[j] ?? "";
      if (INLINE.test(word)) {
        const code = words.slice(j + 1).join(" ");
        if (SHELL.test(name) && depth < 3) found.push(...scriptsRun(code, dir ?? cwd, depth + 1));
        for (const m of code.matchAll(/\b(?:require|import)\s*\(?\s*(\.{1,2}[/\\][^\s)]+)/g))
          found.push({ file: m[1] ?? "", dir });
        break;
      }
      if (/^-m$/.test(word)) {
        // A module of this folder is a file the run may have written; an installed one is not here.
        const mod = (words[j + 1] ?? "").replace(/\./g, "/");
        const here = [`${mod}.py`, join(mod, "__main__.py")].find((f) => dir && existsSync(resolve(dir, f)));
        if (here) found.push({ file: here, dir });
        break;
      }
      // A preloaded file, joined to its flag (`--require=./x`, `-r./x`) or as the next word.
      const joined = /^(--require|--import|--loader|--experimental-loader)=(.+)$/.exec(word) ?? /^-r(.+)$/.exec(word);
      if (joined) {
        found.push({ file: joined[2] ?? joined[1] ?? "", dir });
        continue;
      }
      if (PRELOAD.test(word)) {
        found.push({ file: words[j + 1] ?? "", dir });
        j++;
        continue;
      }
      if (word.startsWith("-")) continue;
      found.push({ file: word, dir });
      break;
    }
  }
  return found.filter((f) => f.file);
}

/**
 * Why a shell command may not run because it runs a script this run wrote or changed, or undefined (#284). A
 * text rule can't read a file's code before it runs, so such a script could do anything the rules refuse. A
 * script identical to the one in a commit the run started from is the project's own and may run; `npm run`
 * and `npm start` run the project's scripts as before.
 */
export function scriptViolation(command: string, cwd: string, env: NodeJS.ProcessEnv = {}): string | undefined {
  const bases = (env[RUN_BASES_ENV] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[0-9a-f]{7,40}$/i.test(s));
  for (const { file, dir } of scriptsRun(command, cwd)) {
    if (!dir || /[$`%*?]/.test(file)) return `can't tell which script "${file.slice(0, 60)}" is, so it may not run`;
    const path = resolve(dir, file);
    if (!unchangedFromBase(path, bases, env.FAULTFORGE_RUN_ROOT)) {
      return `a script this run wrote or changed (${basename(path)}) may not run directly: its code can't be checked before it does. Run the project's own scripts with npm run, and put new logic in the code and its tests`;
    }
  }
  return undefined;
}

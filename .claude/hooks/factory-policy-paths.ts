/**
 * The factory policy's rules about files (AUD-H2, re-grade after round 4): what a run may not read (the
 * process files under `/proc`, and in a target ticket's run the private checkouts), which files a shell
 * command may not write (the guardrails: `.claude/` and the giveaway word list), and which scripts it may not
 * run (one the agent wrote in this run, which no text rule can read before it runs). Split from
 * factory-policy.ts, which may not pass 400 lines.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { codeAsWords, spokenWords } from "./shell-decode.ts";
import { quotedMask } from "./shell-scan.ts";

/** The runner's list of private checkouts a target ticket's run must not read, as the agent's environment holds it. */
export const PRIVATE_CHECKOUTS_ENV = "FAULTFORGE_PRIVATE_CHECKOUTS";

/** The private repo's own files by name: the answer key, the audit log, the backlog and the templates. */
const PRIVATE_NAMES = /ground[-_]?truth|audit[-_]events|BACKLOG\.md|private[/\\]+(templates|config|cases)\b/i;

/**
 * The private files no run reads, a lab ticket's included, by their path in the private checkout: the answer
 * key, the audit log and the unreleased templates. A lab ticket's agent saves evidence there, never reads these.
 */
const ANSWER_FILES = /private[/\\]+(ground-truth\.jsonl|audit-events\.jsonl|templates\b|cases\b)/i;

/** Files under `/proc` that hold a process's environment or memory: `environ`, and anything of `self`. */
const PROC = /\/proc\/(self|thread-self|\d+|\$|\*|\[|\{)|\/proc\/[^\s/]*\/(environ|mem|cmdline|maps|fd)\b/i;

/** The guardrails a shell command may not write: anything under `.claude`, and the giveaway word list. */
const GUARDRAILS = /(^|[\s'"=:(/\\])\.claude([/\\\s'")]|$)|\bneutral\.ts\b/i;

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

/** A path's spellings as a command could write it: native, forward slashes, lower case. */
function spellings(path: string): string[] {
  const forward = path.replace(/\\/g, "/");
  return [path, forward, path.toLowerCase(), forward.toLowerCase(), forward.replace(/^([a-z]):/i, "/$1")];
}

/**
 * Why a read tool (Read, Grep, Glob) may not read what it names, or undefined: a process file under `/proc`
 * in any run, and in a target ticket's run a private checkout or a private file by name (#284).
 */
export function readViolation(args: Record<string, unknown>, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const texts = ["file_path", "path", "pattern", "glob", "notebook_path"]
    .map((key) => args[key])
    .filter((v): v is string => typeof v === "string" && v !== "");
  if (texts.some((t) => PROC.test(t.replace(/\\/g, "/")))) return "no reading process files under /proc";
  const paths = ["file_path", "path", "notebook_path"]
    .map((key) => args[key])
    .filter((v): v is string => typeof v === "string" && v !== "")
    .map((v) => resolve(cwd, v));
  if ([...texts, ...paths].some((t) => ANSWER_FILES.test(t)))
    return "no run reads the answer key, the audit log or the templates";
  const checkouts = privateCheckouts(env);
  if (!checkouts.length) return undefined;
  if (texts.some((t) => PRIVATE_NAMES.test(t))) return "a target ticket's run doesn't read the private repo";
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = args[key];
    if (typeof value !== "string" || !value) continue;
    const target = real(resolve(cwd, value));
    if (checkouts.some((c) => inside(target, real(c)) || inside(resolve(cwd, value), c)))
      return "a target ticket's run doesn't read the private repo";
  }
  return undefined;
}

/** Why a shell command may not run in a target ticket's run because it names the private repo, or undefined. */
export function privateCommandViolation(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const readings = [command, spokenWords(command)];
  if (readings.some((r) => ANSWER_FILES.test(r))) return "no run reads the answer key, the audit log or the templates";
  const checkouts = privateCheckouts(env);
  if (!checkouts.length) return undefined;
  const named = (text: string) => {
    const lower = text.toLowerCase().replace(/\\/g, "/");
    return checkouts.some((c) => spellings(c).some((s) => lower.includes(s.toLowerCase().replace(/\\/g, "/"))));
  };
  if (readings.some((r) => PRIVATE_NAMES.test(r) || named(r)))
    return "a target ticket's run doesn't read or change the private repo";
  return undefined;
}

/** Why a shell command may not run because it would write a guardrail file, or undefined. */
export function guardrailWriteViolation(command: string): string | undefined {
  const readings = [command, spokenWords(command), codeAsWords(command)];
  if (readings.some((r) => GUARDRAILS.test(r)) && readings.some((r) => SHELL_WRITE.test(r)))
    return "the agent can't change its own guardrails (.claude, neutral.ts) from the shell either";
  return undefined;
}

/** Programs that run a script file given as their first argument. */
const INTERPRETER =
  /^(node|nodejs|deno|bun|tsx|ts-node|python\d*(\.\d+)?|py|perl|ruby|php|bash|sh|zsh|dash|ksh|fish|pwsh|powershell)$/i;
/** Flags that make the interpreter run code from the command line rather than a file. */
const INLINE = /^(-e|-c|-p|-pe|-ne|--eval|--print|-Command|-EncodedCommand|-m)$/i;
/** Flags whose value is a file the interpreter loads before the script. */
const PRELOAD = /^(-r|--require|--import|--loader|--experimental-loader|-File)$/i;

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

/** True when `file` is in its repository's `origin/main` (or HEAD, without one): not a file this run wrote. */
function committedBefore(file: string): boolean {
  const dir = dirname(file);
  if (!existsSync(dir)) return false;
  const top = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 5000 });
  if (top.status !== 0) return false;
  const root = top.stdout.trim();
  const rel = relative(real(root), real(file)).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return false;
  for (const rev of ["origin/main", "HEAD"]) {
    const has = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", rev], { timeout: 5000 });
    if (has.status !== 0) continue;
    return spawnSync("git", ["-C", root, "cat-file", "-e", `${rev}:${rel}`], { timeout: 5000 }).status === 0;
  }
  return false;
}

/**
 * The script files a command runs: an interpreter's first argument, a file it preloads, a relative module
 * that inline code requires, and a path run as a program. Each comes with the folder it is read from, which
 * follows the command's own `cd` steps; `undefined` for a folder the hook can't know.
 */
export function scriptsRun(command: string, cwd: string): { file: string; dir: string | undefined }[] {
  const found: { file: string; dir: string | undefined }[] = [];
  let dir: string | undefined = cwd;
  for (const step of steps(command)) {
    const words = spokenWords(step).split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && /^([A-Za-z_]\w*=|sudo$|env$|exec$|time$|nice$|command$|\()/.test(words[i] ?? "")) i++;
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
      if (/[/\\]/.test(program) && /\.\w+$/.test(program)) found.push({ file: program, dir });
      continue;
    }
    for (let j = at + 1; j < words.length; j++) {
      const word = words[j] ?? "";
      if (INLINE.test(word)) {
        const code = words.slice(j + 1).join(" ");
        for (const m of code.matchAll(/\b(?:require|import)\s*\(?\s*(\.{1,2}[/\\][^\s)]+)/g))
          found.push({ file: m[1] ?? "", dir });
        break;
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
 * Why a shell command may not run because it runs a script this run wrote, or undefined (#284). A text rule
 * can't read a file's code before it runs, so a script the agent wrote could do anything the rules refuse.
 * A script that is in its repository's `origin/main` is the project's own and may run; a new one, one outside
 * any repository, or one whose name or folder the shell builds may not.
 */
export function scriptViolation(command: string, cwd: string): string | undefined {
  for (const { file, dir } of scriptsRun(command, cwd)) {
    if (!dir || /[$`%*?]/.test(file)) return `can't tell which script "${file.slice(0, 60)}" is, so it may not run`;
    const path = resolve(dir, file);
    if (!committedBefore(path)) {
      return `a script this run wrote (${basename(path)}) may not run: its code can't be checked before it does. Put the logic in the repo's own code and its tests`;
    }
  }
  return undefined;
}

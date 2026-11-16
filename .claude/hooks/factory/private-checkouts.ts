/**
 * The factory policy's rules about the private repo (AUD-H2, #284, #299): which of its files no run reads, and
 * which checkouts of it a run's tools must stay out of. Split from factory-policy-paths.ts, which may not pass
 * 400 lines.
 *
 * Every run, a lab ticket's included, is kept out of the private checkouts the runner names in
 * `FAULTFORGE_PRIVATE_CHECKOUTS`: the owner's `<lab>/private`, the runs folder (other runs' worktrees), and in a
 * lab ticket's run its own private worktree, which sits inside the run's folder. The runner, not the agent,
 * writes and commits the evidence there; the agent may only read back what its own tools saved under the
 * evidence folder (`EVIDENCE_READS`): its PR's saved reviews, the factory log and the revert checks.
 */
import { readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { spokenWords } from "../shell/decode.ts";
import { globMatches, hasWildcard } from "../shell/glob.ts";
import { joinedWords, quotedMask, quotedSpans } from "../shell/scan.ts";

/** The runner's list of private checkouts a run must not read, as the agent's environment holds it. */
export const PRIVATE_CHECKOUTS_ENV = "FAULTFORGE_PRIVATE_CHECKOUTS";

/** The private repo's own files by name: the answer key, the audit log, the backlog, held-out files, templates. */
const PRIVATE_NAMES =
  /ground[-_]?truth|audit[-_]events|BACKLOG\.md|HELD[-_]?OUT|private[/\\]+(templates|config|cases)\b/i;

/**
 * The private files no run reads, whatever it is told, by their path in the private checkout: the answer key, the
 * audit log, the held-out files and the unreleased templates.
 */
export const ANSWER_FILES =
  /private[/\\]+(ground-truth\.jsonl|audit-events\.jsonl|templates\b|cases\b)|templates[/\\]+HELD[-_]?OUT/i;

/** True when `path` is `folder` or inside it, compared as the file system does on this platform. */
export function inside(path: string, folder: string): boolean {
  const rel = relative(resolve(folder), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The real path of `path`, through links, or its plain resolved form when it doesn't exist. */
export function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** The fixed folder a glob pattern starts from: everything before its first wildcard. */
export const globBase = (pattern: string) => pattern.split(/[*?[{]/)[0]?.replace(/[^/\\]*$/, "") ?? "";

/** The path a shell word names: itself, or with a wildcard the fixed folder it starts from (`.` when none). */
const fixedPart = (word: string) => (/[*?[{]/.test(word) ? globBase(word) || "." : word);

/** The private checkouts named in the run's environment. */
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

/** The lab repos' names, as review:wait names their saved reviews (`<name>-pr<N>`), from factory.json. */
function labNames(): string[] {
  try {
    const config = JSON.parse(readFileSync(join(import.meta.dirname, "../../../factory.json"), "utf8"));
    const names = Object.values(config.repos as Record<string, { github: string; guard: string }>)
      .filter((r) => r.guard === "lab")
      .map((r) => basename(r.github));
    return names.length ? names : ["faultforge"];
  } catch {
    return ["faultforge"];
  }
}

/**
 * What a run may read in its own private worktree: the reviews of a lab PR that review:wait saved, the factory
 * log and the revert checks. Not other reviews (a reviewed repo's are case evidence), raw case evidence, the
 * answer key, the audit log or the templates.
 */
function evidenceRead(path: string, checkout: string): boolean {
  const rel = relative(checkout, path).replace(/\\/g, "/");
  const names = labNames()
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`^raw-artifacts/(reviews/(${names})-pr\\d+|factory-log|revert-checks)(/|$)`, "i").test(rel);
}

/** The run's folders: its own, and the private checkouts nested in it (a lab ticket's private worktree). */
function runFolders(env: NodeJS.ProcessEnv) {
  const checkouts = privateCheckouts(env);
  const own = env.FAULTFORGE_RUN_ROOT ? resolve(env.FAULTFORGE_RUN_ROOT) : undefined;
  const nested = own ? checkouts.filter((c) => inside(c, own) && !inside(own, c)) : [];
  return { checkouts, own, nested, outer: checkouts.filter((c) => !nested.includes(c)) };
}

const REASON = "a run doesn't read the private repo; the runner writes its evidence";
const HOLDER_REASON =
  "a recursive search from a folder that holds the private worktree reads it too; search a subfolder (packages/, docs/) instead";

/**
 * Why a path a tool would read is in a private checkout, or undefined. `holderOk` says whether reading from a
 * folder that holds the run's own private worktree is fine (Grep: ripgrep skips the git-ignored worktree).
 */
function pathViolation(path: string, env: NodeJS.ProcessEnv, holderOk: boolean): string | undefined {
  const { own, nested, outer } = runFolders(env);
  const hit = nested.find((c) => inside(path, c) || inside(path, real(c)));
  if (hit) return evidenceRead(path, inside(path, hit) ? hit : real(hit)) ? undefined : REASON;
  // Each folder in both spellings, as named and through links (Windows' short names, a junction): a path the read
  // tools resolved through links must still meet its own folder (seen on the Windows CI runner).
  const holds = (c: string) => inside(c, path) || inside(real(c), path);
  if (own && (inside(path, own) || inside(path, real(own))))
    return !holderOk && nested.some(holds) ? HOLDER_REASON : undefined;
  // In a checkout, or a folder that holds one (a search from a parent reads it too; Qodo on PR 288).
  if (outer.some((c) => inside(path, c) || inside(path, real(c)) || holds(c))) return REASON;
  return undefined;
}

/**
 * Why a read tool may not read what it names in a private checkout, or undefined. `texts` are its path-like
 * inputs (a Grep pattern is not one), `resolved` the paths they name, links followed.
 */
export function privateReadViolation(
  tool: string,
  texts: string[],
  resolved: string[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!privateCheckouts(env).length) return undefined;
  if (texts.some((t) => PRIVATE_NAMES.test(t))) return REASON;
  // Grep's ripgrep skips the git-ignored worktree; Glob does too only when the runner turned its --no-ignore off.
  const skipsIgnored =
    tool === "Grep" || (tool === "Glob" && /^(false|0)$/i.test(env.CLAUDE_CODE_GLOB_NO_IGNORE ?? ""));
  for (const path of resolved) {
    const reason = pathViolation(path, env, skipsIgnored);
    if (reason) return reason;
  }
  return undefined;
}

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

/** Tools that read a folder's whole tree, always or with a flag, and how they name it. */
const ALWAYS_RECURSIVE = /^(find|tree|du|tar|zip|7z|rsync|robocopy|xcopy|ack|ugrep)$/;
const GREP_RECURSIVE = /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)$/;
const LIST_RECURSIVE = /^(-[a-zA-Z]*R[a-zA-Z]*|--recursive|-Recurse|\/s)$/i;
const COPY_RECURSIVE = /^(-[a-zA-Z]*[rRa][a-zA-Z]*|--recursive|--archive|-Recurse)$/;
/** ripgrep, ag and git grep skip git-ignored files unless told not to. */
const NO_IGNORE =
  /^(--no-ignore\S*|-u+|--unrestricted|-U|--skip-vcs-ignores|--no-index|--untracked|--no-exclude-standard)$/;

/**
 * The folders a step reads its whole tree of, or none: a recursive grep, find, tree, ls -R, a copy or an archive,
 * and ripgrep or git grep told to read ignored files. With no folder named, it reads the one it runs in.
 */
function recursiveTargets(step: string): string[] {
  const words = spokenWords(step).split(/\s+/).filter(Boolean);
  let i = 0;
  while (
    i < words.length &&
    (/^[A-Za-z_]\w*=/.test(words[i] ?? "") || /^(sudo|env|command|time)$/.test(words[i] ?? ""))
  )
    i++;
  const program = basename(words[i] ?? "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
  let rest = words.slice(i + 1);
  if (program === "git") {
    if (rest[0] !== "grep") return [];
    rest = rest.slice(1);
  }
  const flags = rest.filter((w) => w.startsWith("-") || /^\/[a-z]$/i.test(w));
  const operands = rest.filter((w) => !flags.includes(w));
  let recursive = false;
  let paths = operands;
  if (/^(e|f)?grep$/.test(program)) {
    recursive = flags.some((f) => GREP_RECURSIVE.test(f));
    paths = flags.some((f) => /^(-e|-f|--regexp|--file)/.test(f)) ? operands : operands.slice(1);
  } else if (/^(rg|ag|git)$/.test(program)) {
    recursive = flags.some((f) => NO_IGNORE.test(f));
    paths = operands.slice(1);
  } else if (/^(ls|dir|gci|get-childitem|findstr)$/.test(program)) {
    recursive = flags.some((f) => LIST_RECURSIVE.test(f));
  } else if (/^(cp|copy-item|scp)$/.test(program)) {
    recursive = flags.some((f) => COPY_RECURSIVE.test(f));
  } else recursive = ALWAYS_RECURSIVE.test(program);
  if (!recursive) return [];
  return paths.length ? paths : ["."];
}

/**
 * The folders a command may run its steps in: where it starts, and each folder a `cd` takes it to. A wildcard
 * target is every folder it matches (Qodo on PR 310: `cd priv?te`), or the folder it starts from when there are
 * too many to list.
 */
function folders(command: string, cwd: string): string[] {
  const found = [cwd];
  let here = cwd;
  for (const m of spokenWords(command).matchAll(/(?:^|[;&|(\s])(?:cd|pushd|Set-Location|sl)\s+(?:-\w+\s+)?(\S+)/gi)) {
    const target = (m[1] ?? "").replace(/[;&|)]+$/, "");
    const matches = hasWildcard(target) ? (globMatches(target, here) ?? [resolve(here, fixedPart(target))]) : [];
    here = matches[0] ?? resolve(here, target);
    found.push(here, ...matches.slice(1));
  }
  return found;
}

const VARIABLE_REASON =
  "a run names its folders as written, not through a variable that holds a private checkout or the folder above one";

/**
 * The command with each variable the shell would expand put in from the run's environment (Qodo on PR 310), so a
 * path spelled `$FAULTFORGE_RUN_ROOT/lab/private` is judged as the folder it is. A variable can't be expanded
 * here when it is edited on the way (`${NAME%%:*}`) or named through another (`${!name}`): when that variable
 * holds a private checkout or a folder above one, the command is refused, and so is one that reads a variable
 * naming a checkout any other way (`printenv NAME`, `process.env.NAME`). The run's own folder is set aside, as
 * the path rules set it aside: its ticket file sits in the runs folder, a checkout (Qodo on PR 312), but its own
 * private worktree still counts.
 */
function expandVariables(command: string, env: NodeJS.ProcessEnv) {
  const { checkouts, own, nested } = runFolders(env);
  const touches = (name: string, holders: boolean) =>
    (env[name] ?? "").split(delimiter).some((part) => {
      const path = part.trim();
      if (!isAbsolute(path)) return false;
      if (nested.some((c) => inside(path, c) || (holders && inside(c, path)))) return true;
      if (own && inside(path, own)) return false;
      return checkouts.some((c) => inside(path, c) || (holders && inside(c, path)));
    });
  // A value's backslashes would read as escapes to the word rules below: a path's folders are split by `/`.
  const slashed = (value: string | undefined) => (value ?? "").replace(/\\/g, "/");
  let problem = /\$\{!/.test(command) ? VARIABLE_REASON : undefined;
  const expand = (part: string) =>
    part
      .replace(/\$\{([A-Za-z_]\w*)([^}]*)\}/g, (all, name: string, edit: string) => {
        if (!edit) return slashed(env[name]);
        if (touches(name, true)) problem = VARIABLE_REASON;
        return all;
      })
      .replace(/\$env:([A-Za-z_]\w*)|\$([A-Za-z_]\w*)|%([A-Za-z_]\w*)%/gi, (_all, a, b, c) =>
        slashed(env[a ?? b ?? c]),
      );
  // Single-quoted text is the shell's literal text: no variable in it is expanded (Qodo on PR 312).
  let text = "";
  let at = 0;
  for (const span of quotedSpans(command).filter((s) => s.kind === "single")) {
    text += expand(command.slice(at, span.start)) + command.slice(span.start, span.end);
    at = span.end;
  }
  text += expand(command.slice(at));
  const words = joinedWords(text);
  for (const name of Object.keys(env)) {
    if (problem) break;
    if (words.includes(name) && new RegExp(`\\b${name}\\b`).test(words) && touches(name, false))
      problem = VARIABLE_REASON;
  }
  return { text, problem };
}

/** Why a shell command may not run because it reaches the private repo's files or checkouts, or undefined. */
export function privateCommandViolation(command: string, env: NodeJS.ProcessEnv, cwd?: string): string | undefined {
  const answer = "no run reads the answer key, the audit log or the templates";
  if ([command, spokenWords(command)].some((r) => ANSWER_FILES.test(r))) return answer;
  const { checkouts, own, nested } = runFolders(env);
  if (!checkouts.length) return undefined;
  const expanded = expandVariables(command, env);
  if (expanded.problem) return expanded.problem;
  const spoken = spokenWords(expanded.text);
  const readings = [command, spokenWords(command), expanded.text, spoken];
  if (readings.some((r) => ANSWER_FILES.test(r))) return answer;
  // The run's own folder may sit inside one the runner names (its runs folder): it is set aside first.
  const ownSpellings = own ? spellings(own) : [];
  const named = (text: string) => {
    let lower = text.toLowerCase().replace(/\\/g, "/");
    for (const s of ownSpellings) lower = lower.split(s).join(" ");
    return checkouts.some((c) => !nested.includes(c) && spellings(c).some((s) => lower.includes(s)));
  };
  if (readings.some((r) => PRIVATE_NAMES.test(r) || named(r))) return REASON;
  const start = cwd ?? own ?? ".";
  // Paths as the shell would resolve them (Qodo on PR 288), from every folder the command may be in: one that
  // climbs out of the run's folder with `..`, or whose fixed start (before a wildcard) is in a private checkout.
  const dirs = folders(expanded.text, start);
  // A command run from inside the private worktree, or that moves into it, reads it, whatever it names.
  for (const dir of dirs) {
    const here = pathViolation(resolve(dir), env, true);
    if (here) return here;
  }
  for (const word of spoken.split(/[\s;&|<>()=]+/)) {
    const wild = hasWildcard(word);
    if (!wild && !/[/\\]/.test(word) && !/^\.\.?$/.test(word) && !/^private$/i.test(word)) continue;
    for (const dir of dirs) {
      const base = resolve(dir, fixedPart(word));
      if (own && /(^|[/\\])\.\.([/\\]|$)/.test(word) && !inside(base, own))
        return "a run stays in its own folder: no `..` out of it";
      // A wildcard is judged by the folder it starts from (`private/temp*` by `private/`), and by every path it
      // matches: `priv*/cases` starts from the run's own folder but names its private worktree (Qodo on PR 310).
      const reason = pathViolation(base, env, true);
      if (reason) return reason;
      if (!wild) continue;
      const matches = globMatches(word, dir);
      if (!matches && checkouts.some((c) => inside(c, base))) return REASON;
      for (const match of matches ?? []) {
        const found = pathViolation(match, env, true);
        if (found) return found;
      }
    }
  }
  // A recursive read from a folder that holds the run's own private worktree reads that too.
  for (const step of steps(expanded.text)) {
    for (const target of recursiveTargets(step)) {
      if (dirs.some((dir) => nested.some((c) => inside(c, resolve(dir, fixedPart(target)))))) return HOLDER_REASON;
    }
  }
  return undefined;
}

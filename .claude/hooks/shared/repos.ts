/**
 * Which repositories the guard protects, and how it recognises one in a command or a path: the target,
 * always, plus every repo marked reviewed in `factory.json`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { decodeAnsiC, shellWords } from "../shell/decode.ts";
import { globMatches, hasWildcard } from "../shell/glob.ts";
import { outsidePostedText } from "../shell/posted.ts";
import { joinedWords, quotedSpans, substitutions } from "../shell/scan.ts";

export interface Reviewed {
  /** owner/name on GitHub */
  github: string;
  name: string;
  /** The local checkout's folder name, from its configured path. */
  folder: string;
  /** Where pending content is read from git. */
  checkout: string;
}

/** The lab checkout the hooks run from. */
export const LAB_ROOT = join(import.meta.dirname, "../../..");

/** Always protected, whatever the config says: the config can add reviewed repos, never remove this one. */
const TARGET: Reviewed = {
  github: "AJBeumer/faultforge-target",
  name: "faultforge-target",
  folder: "faultforge-target",
  checkout: resolve(LAB_ROOT, "../faultforge-target"),
};

/** Git's global options that may stand before `-C` (`--no-pager`, `-c key=value`), skipped so `-C` is still seen. */
// `-c key=value` is told from `-C path` by its `=`, since the patterns ignore case and inline case modifiers
// need Node 23. Each option matches only one way, so a run of them without `-C` fails in linear time.
const GIT_OPTIONS = String.raw`(?:(?:-c\s+[^\s=]+=\S*|(?!-C)(?:--[\w-]+|-\w+)(?:=\S+)?)\s+)*`;

export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The target, plus every repo marked reviewed in `factory.json` (or the file `configPath` names, from
 * `FAULTFORGE_CONFIG`). A missing, broken or wrong config can only fail to add a repo; it can never switch
 * off the target's guard.
 */
export function reviewedRepos(configPath: string | undefined): Reviewed[] {
  const repos = [{ ...TARGET }];
  try {
    const path = configPath ?? join(LAB_ROOT, "factory.json");
    const entries: { github?: unknown; path?: unknown; guard?: unknown }[] = Object.values(
      JSON.parse(readFileSync(path, "utf8")).repos ?? {},
    );
    for (const entry of entries) {
      if (entry.guard !== "reviewed" || typeof entry.github !== "string" || typeof entry.path !== "string") continue;
      const known = repos.find((r) => r.github.toLowerCase() === (entry.github as string).toLowerCase());
      if (known) {
        // The config may keep the target's checkout somewhere else; its protection stays either way.
        known.checkout = resolve(LAB_ROOT, entry.path);
        continue;
      }
      const name = entry.github.split("/")[1] ?? entry.github;
      repos.push({
        github: entry.github,
        name,
        folder: basename(entry.path) || name,
        checkout: resolve(LAB_ROOT, entry.path),
      });
    }
  } catch {
    // keep the target alone
  }
  return repos;
}

/** A link GitHub turns into a "mentioned in" event on one of these repos' issues or PRs. */
export function linkPattern(repos: Reviewed[]): RegExp | undefined {
  if (!repos.length) return undefined;
  return new RegExp(
    repos.map((r) => `github\\.com/${esc(r.github)}/(issues|pull)/\\d+|${esc(r.name)}#\\d+`).join("|"),
    "i",
  );
}

/**
 * The ways a command moves into a checkout: `cd`, `pushd`, PowerShell's `Set-Location` (or `sl`), each
 * with an optional `-Path`/`-LiteralPath`, `git -C<path>` with or without a space, and `git --work-tree=` /
 * `--git-dir`. The path may be relative, absolute or quoted, and the folder may be followed by a path
 * separator, a quote, whitespace or a shell operator (`;`, `&&`, `|`).
 */
function checkoutPattern(repo: Reviewed): RegExp {
  const folders = [repo.folder, repo.name].map(esc).join("|");
  // `GIT_DIR=` and `GIT_WORK_TREE=` (or PowerShell's `$env:GIT_DIR =`) point git at a checkout too.
  const into = `(?:\\b(?:cd|pushd|Set-Location|sl)\\s+(?:-(?:Literal)?Path\\s+)?|\\bgit\\s+${GIT_OPTIONS}-C\\s*|\\bgit\\s+${GIT_OPTIONS}--(?:work-tree|git-dir)[=\\s]\\s*|(?:\\$env:|\\b)GIT_(?:DIR|WORK_TREE)\\s*=\\s*)`;
  return new RegExp(`${into}["']?[^\\s"']*(^|[/\\\\])?(${folders})(?=[/\\\\"'\\s;&|)]|$)`, "i");
}

/**
 * True when the command moves into the repo's checkout anywhere in its text, quoted or not: fails closed. Outside
 * posted text it is also read as the shell joins its words (`faultforge-tar''get`); inside a message, joining
 * would turn words like `c''d` into a move.
 */
export function entersCheckout(command: string, repo: Reviewed): boolean {
  const pattern = checkoutPattern(repo);
  return pattern.test(command) || pattern.test(shellWords(outsidePostedText(command)));
}

/** True when a local path is inside the repo's checkout folder (whole folder names only). */
export function inCheckout(path: string, repo: Reviewed): boolean {
  return [repo.folder, repo.name].some((folder) => new RegExp(`(^|[/\\\\])${esc(folder)}([/\\\\]|$)`, "i").test(path));
}

/** A local git checkout found on disk: its top folder and the GitHub repos (owner/name, lower case) its remotes name. */
export interface Checkout {
  root: string;
  remotes: string[];
}

/**
 * The checkout that holds `path`, found by walking up to the nearest `.git` (a folder, or a worktree's
 * `gitdir:` file) and reading the remote URLs from its git config, without running git: the guard needs
 * this for every command, so it must be fast. A path that is itself a git folder (`GIT_DIR=…/.git`) counts.
 * Undefined when no checkout holds the path.
 */
export function checkoutAt(path: string): Checkout | undefined {
  let dir = resolve(path);
  for (;;) {
    // A bare clone keeps its config at its own top, beside HEAD and objects.
    const bare = ["config", "HEAD", "objects"].every((name) => existsSync(join(dir, name)));
    if (bare) return { root: dir, remotes: remotesOf(dir) };
    const gitDir = basename(dir) === ".git" && existsSync(join(dir, "config")) ? dir : join(dir, ".git");
    if (existsSync(gitDir)) {
      const root = gitDir === dir ? dirname(dir) : dir;
      return { root, remotes: remotesOf(gitDir) };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The GitHub repos a git folder's config names as remotes; a worktree's `.git` file leads to the shared config. */
function remotesOf(dotGit: string): string[] {
  try {
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
      if (!pointer) return [];
      gitDir = resolve(dirname(dotGit), pointer);
      const common = join(gitDir, "commondir");
      if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, "utf8").trim());
    }
    const config = readFileSync(join(gitDir, "config"), "utf8");
    // A URL rewrite or an included file changes what the remote really is, so ask git then.
    if (/insteadof|^\s*\[include/im.test(config) || globalRewrites()) return gitRemotes(gitDir);
    return [...config.matchAll(/^\s*(?:push)?url\s*=\s*(.+?)\s*$/gim)].flatMap((m) => githubRepos(m[1] ?? ""));
  } catch {
    return [];
  }
}

/** Whether the user's own git config rewrites URLs or includes other files; read once per process. */
let rewrites: boolean | undefined;
function globalRewrites(): boolean {
  if (rewrites === undefined) {
    try {
      rewrites = /insteadof|^\s*\[include/im.test(readFileSync(join(homedir(), ".gitconfig"), "utf8"));
    } catch {
      rewrites = false;
    }
  }
  return rewrites;
}

/** The GitHub repos git itself reports as a git folder's remotes, URL rewrites applied. */
function gitRemotes(gitDir: string): string[] {
  const result = spawnSync("git", ["--git-dir", gitDir, "remote", "-v"], { encoding: "utf8", timeout: 5000 });
  return (result.stdout ?? "").split("\n").flatMap((line) => githubRepos(line));
}

/**
 * A GitHub URL in any spelling git or gh takes: with or without a scheme, user (`git@`), subdomain or port,
 * then the repo after `/` or the scp-style `:`, with or without `.git`, in any case. Groups: owner, name.
 * A port is only read as one when an `owner/name` follows it; otherwise `:1234/x` is the scp form's owner.
 * The host must be the URL's own host, never inside another host's path (`gitlab.com/github.com/o/n`).
 */
export const GITHUB_URL = String.raw`(?<=^|[\s"'=<(@]|\/\/)(?:[\w-]+\.)*github\.com(?::\d+(?=\/[\w.-]+\/))?[\/:]+([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[\/"'\s?#)]|$)`;

/** Every GitHub repo the text names by URL, as `owner/name` in lower case. */
export function githubRepos(text: string): string[] {
  return [...text.matchAll(new RegExp(GITHUB_URL, "gi"))].map((m) => `${m[1]}/${m[2]}`.toLowerCase());
}

/** The GitHub repo a remote URL points at, as `owner/name` in lower case, or undefined for another host. */
export function githubRepo(url: string): string | undefined {
  return githubRepos(url)[0];
}

/** The path with its nearest existing folder resolved through links; the rest as written. */
function real(path: string): string {
  let head = resolve(path);
  let tail = "";
  for (;;) {
    try {
      return join(realpathSync.native(head), tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail = join(basename(head), tail);
      head = parent;
    }
  }
}

/** True when `path` is `folder` or inside it, compared case-blind on Windows. */
export function within(path: string, folder: string): boolean {
  // Follow symlinks and junctions, so a link can't lead out.
  const fold = (p: string) => (process.platform === "win32" ? real(p).toLowerCase() : real(p));
  const rel = relative(fold(folder), fold(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The reviewed repo whose checkout holds `path`, by folder name or by a remote that points at the repo, so a
 * second clone in a folder with another name is guarded too. Such a clone carries its own folder as `checkout`.
 */
export function locate(path: string, reviewed: Reviewed[]): Reviewed | undefined {
  const named = reviewed.find((r) => inCheckout(path, r) || within(path, r.checkout));
  if (named) return named;
  const found = checkoutAt(path);
  if (!found) return undefined;
  const repo = reviewed.find((r) => found.remotes.includes(r.github.toLowerCase()));
  return repo && { ...repo, checkout: found.root };
}

/** The most folder moves the guard follows in one command; each one costs a walk up the file system. */
export const MAX_MOVES = 32;

const MOVE = new RegExp(
  String.raw`(?:\b(?:cd|pushd|Set-Location|sl)\s+(?:-(?:Literal)?Path\s+)?|\bgit\s+${GIT_OPTIONS}-C\s*|--(?:work-tree|git-dir)[=\s]\s*|\bGIT_(?:DIR|WORK_TREE)\s*=\s*)(?:"([^"]+)"|'([^']+)'|([^\s"';&|<>()]+))`,
  "gi",
);

/** How many folder moves the command makes; the guard refuses one with more than `MAX_MOVES`. */
export function moveCount(command: string): number {
  return [...command.matchAll(MOVE)].length;
}

/**
 * True when a move's path can't be read before the shell runs: built from a variable, a substitution or cmd's
 * `%NAME%`, or `-`, the previous folder. Single-quoted text is literal to the shell, `$` and all.
 */
function unreadablePath(path: string, singleQuoted: boolean): boolean {
  if (path === "-") return true;
  return !singleQuoted && /[$`]|%[A-Za-z_]\w*%/.test(path);
}

/** Where a command moves (see `navigation`): the folders it reaches, and whether one of them can't be read. */
export interface Navigation {
  targets: string[];
  unreadable: boolean;
}

/**
 * The folders a command moves into or points git at, in order, each resolved from the folder the one
 * before left it in: `cd`, `pushd`, `Set-Location`, `git -C`, `--work-tree`, `--git-dir`, `GIT_DIR=` and
 * `GIT_WORK_TREE=`. An unquoted wildcard is expanded against the folders that exist, as the shell does. A path
 * built from a variable or a substitution can't be resolved: it is left out and `unreadable` is set. A wildcard
 * naming more than `MAX_MOVES` folders is unreadable too, so the guard never walks up from thousands of matches.
 */
export function navigation(command: string, cwd: string, acts: (index: number) => boolean = () => true): Navigation {
  const targets: string[] = [];
  let unreadable = false;
  const expand = (path: string, from: string, quoted: boolean): string[] => {
    const full = path.startsWith("~") ? join(homedir(), path.slice(1)) : resolve(from, path);
    if (quoted || !hasWildcard(path)) return [full];
    const found = globMatches(full, from);
    if (!found || targets.length + found.length > MAX_MOVES) {
      unreadable = true;
      return [];
    }
    return found.length ? found : [full];
  };
  let here = cwd;
  for (const m of [...command.matchAll(MOVE)].slice(0, MAX_MOVES)) {
    const path = m[1] ?? m[2] ?? m[3] ?? "";
    if (!path || !acts(m.index ?? 0)) continue;
    if (unreadablePath(path, m[2] !== undefined)) {
      unreadable = true;
      continue;
    }
    const resolved = expand(path, here, m[3] === undefined);
    targets.push(...resolved);
    if (/^(?:cd|pushd|Set-Location|sl)\b/i.test(m[0])) here = resolved[0] ?? here;
    // Each further `-C` of the same git call is resolved from the one before, as git does.
    if (/^git\s/i.test(m[0]) && resolved.length) {
      let dir = resolved[0] ?? here;
      const option = /\s+-C\s*(?:"([^"]+)"|'([^']+)'|([^\s"';&|<>()]+))/y;
      option.lastIndex = (m.index ?? 0) + m[0].length;
      for (let c = option.exec(command); c; c = option.exec(command)) {
        const next = c[1] ?? c[2] ?? c[3] ?? "";
        if (unreadablePath(next, c[2] !== undefined)) {
          unreadable = true;
          break;
        }
        if (targets.length >= MAX_MOVES) break;
        const nested = expand(next, dir, c[3] === undefined);
        if (!nested.length) break;
        dir = nested[0] ?? dir;
        targets.push(...nested);
      }
    }
  }
  return { targets, unreadable };
}

/**
 * The folders a command moves into or points git at (see `navigation`), read as written and as the shell joins
 * each word outside posted text: `cd faultforge-tar''get` goes into `faultforge-target`. The joined reading keeps
 * backslashes, which Windows paths need, and also drops them, as bash does outside quotes.
 */
export function navigationTargets(command: string, cwd: string): string[] {
  const outside = outsidePostedText(command);
  const readings = new Set([command, joinedWords(decodeAnsiC(outside)), shellWords(outside)]);
  return [...new Set([...readings].flatMap((text) => navigation(text, cwd).targets))];
}

/**
 * True when the command moves into a folder the guard can't read before it runs (`cd "$DIR"`, `git -C $(…)`,
 * a wildcard with too many matches): a write after it may land in any reviewed checkout. A move written in a
 * message, a single-quoted string or a comment is only text, so it can't widen a write to every reviewed repo.
 */
export function unreadableMove(command: string, cwd: string, depth = 0): boolean {
  // Spans are read from the command as written: cutting posted values out first can shift a quote and hide a
  // real move. Text that runs a substitution still counts.
  const text = new Array<boolean>(command.length).fill(false);
  for (const span of quotedSpans(command)) if (!span.runs) text.fill(true, span.start, span.end);
  if (navigation(command, cwd, (index) => !text[index]).unreadable) return true;
  // Quotes inside a substitution belong to its own command, so each one is read again on its own.
  return depth < 3 && substitutions(command, true).some((s) => unreadableMove(s.inner, cwd, depth + 1));
}

/** The folder a file edit lands in, or its nearest existing parent: where its checkout is looked up. */
export function existingFolder(path: string): string {
  let dir = path;
  while (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
  return dir;
}

/**
 * Repo names are allowed where they identify a repo: in paths and `owner/name`. Elsewhere they are
 * ordinary words, so a repo named after a forbidden word can't hide that word in a message.
 */
export function stripReviewedNames(reviewed: Reviewed[], text: string): string {
  const repoWords = ["faultforge", ...reviewed.flatMap((r) => [r.name, r.folder])].map(esc);
  const identifies = new RegExp(repoWords.join("|"), "i");
  const owners = [...new Set(reviewed.map((r) => (r.github.split("/")[0] ?? "").toLowerCase()))].map(esc);
  // `owner/name` for a known owner and a repo name, as a whole token or after `=` or an API path's `repos/`.
  // A ref (`HEAD:faultforge/x`, `refs/heads/faultforge/x`, `fix/faultforge`) is none of these.
  const repoId = new RegExp(
    `(^|=|\\brepos/)(?:${owners.join("|")})/(?:${repoWords.join("|")})(?=$|[/#]|\\.git\\b)`,
    "gi",
  );
  // Whole tokens first, then the slash test: one pattern for both backtracks on every long token.
  return text.replace(/[^\s"'`]+/g, (token) => {
    if (!/[/\\]/.test(token) || !identifies.test(token)) return token;
    return isPath(token) ? " " : token.replace(repoId, "$1 ");
  });
}

/**
 * True when a token is a file path or a URL: absolute (`/x`, `C:\x`, `\\host`), relative to here or home
 * (`./`, `../`, `~`), or with a scheme or an scp-style host. A bare `a/b` is not: it may be a ref, and a
 * ref's words count.
 */
function isPath(token: string): boolean {
  // A flag's or a field's value counts as itself: `--git-dir=<path>`, `body=@<path>`.
  return /^(?:-*[\w.-]*=@?|@)?(?:[\\/]|\.{1,2}[\\/]|~|[A-Za-z]:[\\/]|[A-Za-z][\w+.-]*:\/\/|[\w.-]+@[\w.-]+:)/.test(
    token,
  );
}

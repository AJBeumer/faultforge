/**
 * Which repositories the guard protects, and how it recognises one in a command or a path: the target,
 * always, plus every repo marked reviewed in `factory.json`. Used by guard-target.ts.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface Reviewed {
  /** owner/name on GitHub */
  github: string;
  /** The repo name on GitHub. */
  name: string;
  /** The local checkout's folder name, from its configured path. */
  folder: string;
  /** The local checkout, resolved from this repo's root, where pending content is read from git. */
  checkout: string;
}

const LAB_ROOT = join(import.meta.dirname, "../..");

/** Always protected, whatever the config says: the config can add reviewed repos, never remove this one. */
const TARGET: Reviewed = {
  github: "AJBeumer/faultforge-target",
  name: "faultforge-target",
  folder: "faultforge-target",
  checkout: resolve(LAB_ROOT, "../faultforge-target"),
};

/** A string as a literal inside a regular expression. */
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
function checkoutPattern(repo: Reviewed, atSegmentStart: boolean): RegExp {
  const folders = [repo.folder, repo.name].map(esc).join("|");
  const lead = atSegmentStart ? "(?:^|[;&|\\n]\\s*)" : "\\b";
  // `GIT_DIR=` and `GIT_WORK_TREE=` (or PowerShell's `$env:GIT_DIR =`) point git at a checkout too (AUD-M3).
  const envLead = atSegmentStart ? lead : "(?:\\$env:|\\b)";
  const into = `(?:${lead}(?:cd|pushd|Set-Location|sl)\\s+(?:-(?:Literal)?Path\\s+)?|${lead}git\\s+-C\\s*|${lead}git\\s+--(?:work-tree|git-dir)[=\\s]\\s*|${envLead}GIT_(?:DIR|WORK_TREE)\\s*=\\s*)`;
  return new RegExp(`${into}["']?[^\\s"']*(^|[/\\\\])?(${folders})(?=[/\\\\"'\\s;&|)]|$)`, "i");
}

/** True when the command moves into the repo's checkout anywhere in its text, quoted or not: fails closed. */
export function entersCheckout(command: string, repo: Reviewed): boolean {
  return checkoutPattern(repo, false).test(command);
}

/**
 * True only when the move into the checkout is a command of its own (at the start of the command or after a
 * shell operator), not words inside a message. The own-ticket link exemption needs this stricter form, so a
 * quoted `Set-Location <target>` in a commit message can't earn it.
 */
export function navigatesInto(command: string, repo: Reviewed): boolean {
  return checkoutPattern(repo, true).test(command);
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
    return [...config.matchAll(/^\s*(?:push)?url\s*=\s*(.+?)\s*$/gim)].flatMap((m) => {
      const repo = /github\.com[/:]+([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(m[1] ?? "")?.[1];
      return repo ? [repo.toLowerCase()] : [];
    });
  } catch {
    return [];
  }
}

/** True when `path` is `folder` or inside it, compared case-blind on Windows. */
function within(path: string, folder: string): boolean {
  const fold = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(fold(folder), fold(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The reviewed repo whose checkout holds `path`: by folder name, as before, or by a remote that points at
 * the repo on GitHub, so a second clone in a folder with another name is guarded too (AUD-M3). A checkout
 * found by its remote carries its own folder as `checkout`, so its pending content is read from there.
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

const MOVE =
  /(?:\b(?:cd|pushd|Set-Location|sl)\s+(?:-(?:Literal)?Path\s+)?|\bgit\s+-C\s*|--(?:work-tree|git-dir)[=\s]\s*|\bGIT_(?:DIR|WORK_TREE)\s*=\s*)(?:"([^"]+)"|'([^']+)'|([^\s"';&|<>()]+))/gi;

/** How many folder moves the command makes; the guard refuses one with more than `MAX_MOVES`. */
export function moveCount(command: string): number {
  return [...command.matchAll(MOVE)].length;
}

/**
 * The folders a command moves into or points git at, in order, each resolved from the folder the one
 * before left it in: `cd`, `pushd`, `Set-Location`, `git -C`, `--work-tree`, `--git-dir`, `GIT_DIR=` and
 * `GIT_WORK_TREE=`. A path built from a variable can't be resolved here and is left out. At most
 * `MAX_MOVES` are read.
 */
export function navigationTargets(command: string, cwd: string): string[] {
  const targets: string[] = [];
  let here = cwd;
  for (const m of [...command.matchAll(MOVE)].slice(0, MAX_MOVES)) {
    const path = m[1] ?? m[2] ?? m[3] ?? "";
    if (!path || /[$`%]|^~/.test(path) || path === "-") continue;
    const resolved = resolve(here, path);
    targets.push(resolved);
    if (/^(?:cd|pushd|Set-Location|sl)\b/i.test(m[0])) here = resolved;
  }
  return targets;
}

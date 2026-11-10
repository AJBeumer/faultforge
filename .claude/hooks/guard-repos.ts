/**
 * Which repositories the guard protects, and how it recognises one in a command or a path: the target,
 * always, plus every repo marked reviewed in `factory.json`. Used by guard-target.ts.
 */
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

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
  const into = `(?:${lead}(?:cd|pushd|Set-Location|sl)\\s+(?:-(?:Literal)?Path\\s+)?|${lead}git\\s+-C\\s*|${lead}git\\s+--(?:work-tree|git-dir)[=\\s]\\s*)`;
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

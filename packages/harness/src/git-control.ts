/**
 * What decides which programs git runs in a checkout: its hooks and its config (a hook, `core.hooksPath`,
 * `core.fsmonitor`, a filter or a credential helper all run a program). In a factory run the agent can write the
 * `.git` folder of a checkout it works in, so after it ends the runner commits there only when these are as they
 * were before it started (#335). Read straight from the files, never through git, which would already obey them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { sha256 } from "./provenance.ts";

/** The key of a checkout's print among a workspace's fingerprints. */
export const GIT_CONTROL = (checkout: string) => `the git hooks and config of ${checkout}`;

/** The checkout's own git folder and the shared one (the same folder unless it is a linked worktree). */
function gitFolders(checkout: string): { own: string; common: string } | undefined {
  const dotGit = join(checkout, ".git");
  if (!existsSync(dotGit)) return undefined;
  let own = dotGit;
  if (!statSync(dotGit).isDirectory()) {
    const line = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
    if (!line) return undefined;
    own = isAbsolute(line) ? line : resolve(checkout, line);
  }
  const commondir = join(own, "commondir");
  const common = existsSync(commondir) ? resolve(own, readFileSync(commondir, "utf8").trim()) : own;
  return { own, common };
}

/** Every file under a folder, as `path\ncontent`, sorted; a folder that is missing reads as none. */
function filesUnder(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [`${name}: (missing)`];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((path) => {
      const stat = statSync(path, { throwIfNoEntry: false });
      return `${name}:${path.slice(dir.length)}\n${stat?.isFile() ? readFileSync(path, "utf8") : "(not a file)"}`;
    });
}

/** A print of the checkout's hooks and config: the shared config and hooks, and a worktree's own config. */
export function gitControlPrint(checkout: string): string {
  const folders = gitFolders(checkout);
  if (!folders) return sha256("(no git folder)");
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "(missing)");
  return sha256(
    [
      `config\n${read(join(folders.common, "config"))}`,
      `config.worktree\n${read(join(folders.own, "config.worktree"))}`,
      ...filesUnder(join(folders.common, "hooks"), "hooks"),
      ...(folders.own === folders.common ? [] : filesUnder(join(folders.own, "hooks"), "own hooks")),
    ].join("\n"),
  );
}

/** Why the runner may not run git with hooks in `checkout`, or undefined when its hooks and config are unchanged. */
export function gitControlProblem(checkout: string, prints: Record<string, string>): string | undefined {
  const before = prints[GIT_CONTROL(checkout)];
  if (!before)
    return `there is no print of ${checkout}'s git hooks and config from before the agent, so it isn't trusted`;
  if (gitControlPrint(checkout) !== before)
    return `${checkout}'s git hooks or config changed while the agent ran, so the runner won't run git there`;
  return undefined;
}

/**
 * What decides which programs git runs in a checkout: its hooks and its config (a hook, `core.hooksPath`,
 * `core.fsmonitor`, a filter or a credential helper all run a program). In a factory run the agent can write the
 * `.git` folder of a checkout it works in, so after it ends the runner commits there only when these are as they
 * were before it started. Read straight from the files, never through git, which would already obey them:
 * each hook's mode with its text (a hook made executable starts to run), and every file a config includes
 * (`include.path`, `includeIf.*.path`), as git would read it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { sha256 } from "../shared/provenance.ts";

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

/** Every file under a folder, as `path mode` and its content, sorted; a folder that is missing reads as none. */
function filesUnder(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [`${name}: (missing)`];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((path) => {
      const stat = statSync(path, { throwIfNoEntry: false });
      const mode = stat ? (stat.mode & 0o7777).toString(8) : "gone";
      const text = stat?.isFile() ? readFileSync(path, "utf8") : "(not a file)";
      return [`${name}:${path.slice(dir.length)} ${mode}`, text].join("\n");
    });
}

/** How deep includes are followed; a deeper one (or a loop) reads as its own text, so the print still changes. */
const MAX_INCLUDE_DEPTH = 10;

/** A config file's text, followed by the text of every file it includes, in order, as git reads them. */
export function configWithIncludes(path: string, depth = 0): string {
  if (!existsSync(path)) return "(missing)";
  const text = readFileSync(path, "utf8");
  if (depth >= MAX_INCLUDE_DEPTH) return text;
  const parts = [text];
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\s*([^\]\s"]+)/);
    if (header) section = (header[1] ?? "").toLowerCase();
    const value = line.match(/^\s*path\s*=\s*(.*?)\s*$/i)?.[1];
    if (value === undefined || (section !== "include" && section !== "includeif")) continue;
    const raw = value.replace(/^"(.*)"$/, "$1");
    const target = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : resolve(dirname(path), raw);
    parts.push([`include ${raw}`, configWithIncludes(target, depth + 1)].join("\n"));
  }
  return parts.join("\n");
}

/** A print of the checkout's hooks and config: the shared config and hooks, and a worktree's own config. */
export function gitControlPrint(checkout: string): string {
  const folders = gitFolders(checkout);
  if (!folders) return sha256("(no git folder)");
  return sha256(
    [
      ["config", configWithIncludes(join(folders.common, "config"))].join("\n"),
      ["config.worktree", configWithIncludes(join(folders.own, "config.worktree"))].join("\n"),
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

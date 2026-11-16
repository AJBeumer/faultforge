/**
 * The factory policy's rule about the home folder (re-grade 6): a run never reads the owner's secrets there. In a
 * local run the agent runs as the owner, so a plain read would reach the Qodo key (`~/.qodo`), the GitHub tokens
 * (`~/.github`, `~/.config/gh/hosts.yml`), SSH keys (`~/.ssh`), Claude's credentials (`~/.claude`) and any other
 * file whose name says it holds a token, a key or a credential. Refused by the read tools and by the shell, in any
 * spelling of the home folder: `~`, `$HOME`, `%USERPROFILE%`, `$env:USERPROFILE`, or the path itself. The run's
 * own folder and the temp folder may sit under the home folder (on a CI runner, and Windows' temp): those stay
 * readable. Split from factory/paths.ts, which may not pass 400 lines.
 */
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { esc } from "../shared/repos.ts";
import { spokenWords } from "../shell/decode.ts";

/** Folders directly under the home folder that hold credentials. */
const SECRET_FOLDERS =
  /^(\.qodo|\.github|\.ssh|\.gnupg|\.aws|\.azure|\.docker|\.kube|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials)$/i;

/** A file or folder whose name says it holds a secret. */
const SECRET_NAME = /token|key|credential|secret|passw/i;

/** The reason given for any read of a secret in the home folder. */
export const HOME_SECRET_REASON =
  "a run never reads the owner's secrets in the home folder (~/.qodo, ~/.github, ~/.config/gh, ~/.ssh, ~/.claude credentials, or a file named for a token, key or credential)";

/** The home folders this process could mean: the OS's, and `HOME` and `USERPROFILE` when set. */
function homes(env: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set([homedir(), env.HOME, env.USERPROFILE].filter((h): h is string => Boolean(h)).map((h) => resolve(h))),
  ];
}

/** True when `path` is `folder` or inside it, compared case-blind on Windows. */
function inside(path: string, folder: string): boolean {
  const fold = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(fold(folder), fold(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The folders a run may read even under the home folder: its own and the temp folder. */
function allowed(env: NodeJS.ProcessEnv): string[] {
  return [env.FAULTFORGE_RUN_ROOT, tmpdir()].filter((p): p is string => Boolean(p)).map((p) => resolve(p));
}

/**
 * True when reading `path` (a file, or a folder a search walks) could read a home-folder secret: it is a secret
 * under a home folder, or it is a home folder or a folder above one, whose search would walk into them.
 */
export function homeSecretPath(path: string, env: NodeJS.ProcessEnv): boolean {
  const full = path.startsWith("~") ? join(homedir(), path.slice(1)) : resolve(path);
  if (allowed(env).some((ok) => inside(full, ok))) return false;
  return homes(env).some((home) => {
    if (inside(home, full)) return true;
    if (!inside(full, home)) return false;
    const parts = relative(home, full)
      .split(/[/\\]+/)
      .filter(Boolean);
    const [first = "", second = ""] = parts;
    if (SECRET_FOLDERS.test(first)) return true;
    if (/^\.config$/i.test(first) && /^gh$/i.test(second)) return true;
    return parts.some((part) => SECRET_NAME.test(part));
  });
}

/** A path's spellings as a command could write it: forward slashes, lower case, and Git Bash's `/d/…`. */
function spellings(path: string): string[] {
  const forward = resolve(path).replace(/\\/g, "/").toLowerCase();
  return [...new Set([forward, forward.replace(/^([a-z]):/, "/$1")])];
}

/** The home folder named by the shell: `~` at a word's start, `$HOME`, `%USERPROFILE%`, `$env:USERPROFILE`. */
const HOME_WORD =
  /(?:^|[\s"'=:(])~(?=[/\\\s"')]|$)|\$\{?HOME\b|\$env:(?:HOME|USERPROFILE|HOMEPATH)\b|%(?:HOME|USERPROFILE|HOMEPATH|HOMEDRIVE)%|\$\{?(?:USERPROFILE|HOMEPATH)\b/i;

/** Names in the home folder that hold secrets, and words that say a file holds one. */
const SECRET_TEXT =
  /(?:^|[/\\\s"'=])(?:\.qodo|\.github|\.ssh|\.gnupg|\.aws|\.azure|\.docker|\.kube|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|\.claude|\.config[/\\]+gh)\b|token|key|credential|secret|passw/i;

/**
 * Why a shell command may not run because it could read a secret in the home folder, or undefined: it names the
 * home folder (in any spelling, a variable the run's environment sets to it included), outside the run's own
 * folder and the temp folder, and either names a secret, uses a wildcard, or names the home folder alone, from
 * which any relative read or search could reach one.
 */
export function homeSecretCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
  // Variables the environment sets are read as their values, so `cat $QODO_KEY_FILE` is a path like any other.
  const expanded = command.replace(
    /\$\{?([A-Za-z_]\w*)\}?|\$env:([A-Za-z_]\w*)|%([A-Za-z_]\w*)%/g,
    (all, a, b, c) => env[a ?? b ?? c] ?? all,
  );
  let text = [command, expanded, spokenWords(expanded)].join("\n").replace(/\\/g, "/").toLowerCase();
  for (const ok of allowed(env)) for (const spelling of spellings(ok)) text = text.split(spelling).join(" ");
  const literal = homes(env).flatMap(spellings);
  // A bare `cd` (or `pushd`) moves to the home folder without naming it (Qodo on PR 333).
  const bareMove = /(?:^|[;&|(\n])\s*(?:cd|pushd|chdir)\s*(?=$|[;&|)\n])/m.test(text);
  const named = bareMove || HOME_WORD.test(text) || literal.some((home) => text.includes(home));
  if (!named) return undefined;
  // The home folder alone: `~` or `$HOME` with no path after it, its literal path ending there, or a bare `cd`.
  const alone =
    bareMove ||
    /(?:^|[\s"'=:(])~(?=[\s"')]|$)|\$\{?home\}?(?![/\w])|%userprofile%(?![/\w])|\$env:userprofile(?![/\w])/i.test(
      text,
    ) ||
    literal.some((home) => new RegExp(`${esc(home)}/?(?=[\\s"')]|$)`).test(text));
  if (alone || /[*?[]/.test(text) || SECRET_TEXT.test(text)) return HOME_SECRET_REASON;
  return undefined;
}

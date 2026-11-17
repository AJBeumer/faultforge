/**
 * Whether a checkout's `origin` can send a push only to the configured repository: every address it fetches from
 * and pushes to, and no URL rewrite in git's config. Split from `ci-wait.ts`, which pushes by the remote's name.
 */
import { remoteIs } from "./ci-wait-verdict.ts";

/** git in a folder, returning its output; throws when it fails. */
export type Git = (cwd: string, ...args: string[]) => string;

/** Why `origin` could send a push anywhere but `github`, or undefined. Throws when git can't be read. */
export function originProblem(
  checkout: string,
  github: string,
  git: Git,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fetchFrom = git(checkout, "remote", "get-url", "--all", "origin").split(/\r?\n/);
  const pushTo = git(checkout, "remote", "get-url", "--push", "--all", "origin").split(/\r?\n/);
  // Git rewrites even an explicit address through `url.<base>.insteadOf` and `pushInsteadOf`, so with any
  // such rule the address checked here might not be where the push goes. The door refuses them the same way.
  let rewrites = "";
  try {
    rewrites = git(checkout, "config", "--get-regexp", String.raw`^url\..*\.(insteadof|pushinsteadof)$`);
  } catch {
    // git exits 1 when no key matches: no rewrite.
  }
  if (rewrites.trim()) return "this checkout's git config rewrites remote addresses";
  if (![...fetchFrom, ...pushTo].every((address) => remoteIs(address, github)))
    return `this checkout's origin is not github.com/${github} for both fetching and pushing`;
  // Over ssh, a command of one's own (`core.sshCommand`, `GIT_SSH`, `GIT_SSH_COMMAND`) decides where git
  // really connects, whatever the address says. Over https, TLS to github.com does.
  if (pushTo.some((address) => !/^https:/i.test(address.trim())) && sshOverride(checkout, git, env))
    return "this checkout pushes over ssh through a command of its own (core.sshCommand or GIT_SSH)";
  return undefined;
}

/** True when git would reach ssh through a command set in its config or in the environment. */
function sshOverride(checkout: string, git: Git, env: NodeJS.ProcessEnv): boolean {
  if (env.GIT_SSH || env.GIT_SSH_COMMAND) return true;
  try {
    return git(checkout, "config", "--get", "core.sshCommand").trim() !== "";
  } catch {
    return false; // git exits 1 when the key is not set
  }
}

/** True when `origin` still goes to `github` only. Reading it failing counts as not. */
export function originIs(checkout: string, github: string, git: Git, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return originProblem(checkout, github, git, env) === undefined;
  } catch {
    return false;
  }
}

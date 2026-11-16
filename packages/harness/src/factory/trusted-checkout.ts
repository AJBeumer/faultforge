/**
 * A fresh checkout of the harness's `main`, with no inherited git or npm config. The runner verifies a pull
 * request from it, never from the agent's own worktree, which the agent could have changed.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { CALL_TIMEOUT_MS, runExternal } from "../shared/github.ts";
import { LONG_CALL_TIMEOUT_MS, npm } from "./factory-exec.ts";

/** No global, user or system git and npm config: a `url.*.insteadOf` rule or a registry override sits
 * outside any commit a reviewer sees, and could redirect even a literal URL. */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1" };
}

/** `git`, with no config inherited beyond what `isolatedEnv` allows. Also used by `factory-check-files.ts`. */
export function gitIsolated(cwd: string, home: string, args: string[], timeoutMs: number): string {
  return runExternal(`git ${args[0] ?? ""}`.trim(), "git", ["-C", cwd, ...args], timeoutMs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedEnv(home),
  }).trim();
}

/**
 * A new repository at `<verifyRoot>/<labDirName>`, checked out at `remoteUrl`'s `main`, that `verifyPr` runs
 * `revert:check` from. A pull request that edits `revert-check.ts` is then judged by the merged code, not its own.
 *
 * - A fresh `git init`, not a worktree: an existing checkout's `.git/config` can hold a redirect rule that no
 *   tracked file shows.
 * - `remoteUrl` comes from `factory.json`, so any change to it shows in the pull request's diff.
 * - A real `npm ci`, never another checkout's `node_modules`: that folder is in no commit, so an edited
 *   dependency would run as if trusted.
 * - `sibling` (a repo whose path isn't `.`, such as the target) is checked out fresh the same way at the same
 *   relative path, never linked: the agent can write its `.git` hooks and filters, and git would run them.
 *
 * Throws a clear message if it can't be built, after removing anything it made.
 */
export function buildTrustedCheckout(
  verifyRoot: string,
  labDirName: string,
  remoteUrl: string,
  sibling?: { remoteUrl: string; path: string },
): string {
  const lab = join(verifyRoot, labDirName);
  try {
    freshCheckout(lab, verifyRoot, remoteUrl);
    if (sibling) freshCheckout(resolve(lab, sibling.path), verifyRoot, sibling.remoteUrl);
    return lab;
  } catch (error) {
    removeTrustedCheckout(verifyRoot);
    const why = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`couldn't build a clean checkout of main to run revert:check from: ${why}`);
  }
}

/** A new repository at `dir`, its "origin" at `remoteUrl`, checked out at that `main`, with its packages installed. */
function freshCheckout(dir: string, home: string, remoteUrl: string): void {
  mkdirSync(dir, { recursive: true });
  gitIsolated(dir, home, ["init", "-q"], CALL_TIMEOUT_MS);
  // A named "origin", not a one-off fetch URL: `revert-check.ts` fetches a pull request's branch from
  // "origin" by name when the pull request is against the harness itself.
  gitIsolated(dir, home, ["remote", "add", "origin", remoteUrl], CALL_TIMEOUT_MS);
  gitIsolated(dir, home, ["fetch", "--quiet", "origin", "main"], LONG_CALL_TIMEOUT_MS);
  gitIsolated(dir, home, ["checkout", "-q", "FETCH_HEAD"], CALL_TIMEOUT_MS);
  const install = npm(dir, ["ci", "--no-audit", "--no-fund"], LONG_CALL_TIMEOUT_MS, isolatedEnv(home));
  if (install.status !== 0) throw new Error(`npm ci failed in the trusted checkout: ${install.output.slice(-400)}`);
}

/** Removes `verifyRoot` and everything in it. Never throws: it returns what to remove by hand instead. */
export function removeTrustedCheckout(verifyRoot: string): string | null {
  try {
    rmSync(verifyRoot, { recursive: true, force: true });
    return null;
  } catch (error) {
    return `couldn't remove the trusted checkout at ${verifyRoot}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * A fresh checkout of the harness's `main`, with no inherited git or npm config, that the runner verifies a
 * pull request from instead of the agent's own worktree (#161). Split from factory-tick.ts (#227).
 */
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { LONG_CALL_TIMEOUT_MS, npm } from "./factory-exec.ts";
import { CALL_TIMEOUT_MS, runExternal } from "./github.ts";

/** No inherited git or npm config at all: not the user's global `~/.gitconfig` or `~/.npmrc`, not
 * system-wide config either. `buildTrustedCheckout`'s whole point is a checkout nothing the agent did
 * can redirect; a `url.*.insteadOf` rule or a registry override, sitting outside any commit a reviewer
 * sees, would otherwise do exactly that even to a literal URL (Qodo on PR 167, round 2). */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1" };
}

/** `git`, with no config inherited beyond what `isolatedEnv` allows. */
function gitIsolated(cwd: string, home: string, args: string[], timeoutMs: number): string {
  return runExternal(`git ${args[0] ?? ""}`.trim(), "git", ["-C", cwd, ...args], timeoutMs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedEnv(home),
  }).trim();
}

/**
 * A freshly initialized git repository, checked out at `remoteUrl`'s `main`, built at
 * `<verifyRoot>/<labDirName>`: the trusted copy of the harness `verifyPr` runs `revert:check` from, so
 * a pull request that edits `revert-check.ts` or a module it imports is judged by what's merged into
 * `main`, never by what that same pull request's own branch holds in the agent's writable worktree
 * (#161).
 *
 * A fresh `git init`, not a worktree of some existing checkout: that checkout's own local config
 * (`.git/config`) could carry a `url.*.insteadOf` rule an agent set without ever touching a tracked
 * file, silently redirecting even this literal `remoteUrl` to an attacker-controlled `main`. A brand
 * new repository, run with no inherited git or npm config at all (`isolatedEnv`), has nothing like
 * that to inherit (Qodo on PR 167, round 2). `remoteUrl` itself comes from the caller's own
 * `factory.json` reading, a tracked file any edit to would show up in the pull request's own diff
 * (Qodo on PR 167). Its packages are a real `npm ci` against the checked-out lockfile, never shared in
 * from some other checkout's own `node_modules`: that folder is never part of any commit a reviewer
 * sees, so an agent's edit to an installed dependency (`tsx`, a module `revert-check.ts` imports)
 * would otherwise run as if it were trusted, even though the source it was fetched alongside never
 * was (Qodo on PR 167). When `sibling` is given (a repo whose `factory.json` path isn't `.`, such as
 * the target), its real checkout is symlinked in at the same relative path, so `revert-check.ts`'s own
 * path arithmetic (relative to wherever it's running from) finds it exactly as it would in the
 * agent's worktree.
 *
 * Throws, with a clear message, when the checkout can't be built - removing anything already made
 * first, so a failure here never leaves anything behind to clean up by hand.
 */
export function buildTrustedCheckout(
  verifyRoot: string,
  labDirName: string,
  remoteUrl: string,
  sibling?: { source: string; path: string },
): string {
  const lab = join(verifyRoot, labDirName);
  try {
    mkdirSync(lab, { recursive: true });
    gitIsolated(lab, verifyRoot, ["init", "-q"], CALL_TIMEOUT_MS);
    // A real "origin", not just a one-off fetch URL: `revert-check.ts`'s own logic fetches a pull
    // request's branch from "origin" by name when the repo under test is this very checkout (a
    // pull request against the harness itself, exactly like this one).
    gitIsolated(lab, verifyRoot, ["remote", "add", "origin", remoteUrl], CALL_TIMEOUT_MS);
    gitIsolated(lab, verifyRoot, ["fetch", "--quiet", "origin", "main"], LONG_CALL_TIMEOUT_MS);
    gitIsolated(lab, verifyRoot, ["checkout", "-q", "FETCH_HEAD"], CALL_TIMEOUT_MS);
    const install = npm(lab, ["ci", "--no-audit", "--no-fund"], LONG_CALL_TIMEOUT_MS, isolatedEnv(verifyRoot));
    if (install.status !== 0) throw new Error(`npm ci failed in the trusted checkout: ${install.output.slice(-400)}`);
    if (sibling) symlinkSync(sibling.source, resolve(lab, sibling.path), "junction");
    return lab;
  } catch (error) {
    removeTrustedCheckout(verifyRoot);
    const why = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`couldn't build a clean checkout of main to run revert:check from: ${why}`);
  }
}

/**
 * Removes a checkout `buildTrustedCheckout` made: `verifyRoot` and everything in it. There's no shared
 * repository to deregister from - the checkout is its own freshly initialized one - so this is just a
 * removal. Never throws; the message describes what to remove by hand instead.
 */
export function removeTrustedCheckout(verifyRoot: string): string | null {
  try {
    rmSync(verifyRoot, { recursive: true, force: true });
    return null;
  } catch (error) {
    return `couldn't remove the trusted checkout at ${verifyRoot}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

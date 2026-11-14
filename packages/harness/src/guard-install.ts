/**
 * Installs the git-level guard in every reviewed checkout named in `factory.json` (#191).
 *
 *   npm run guard:install
 *
 * For each repo with `"guard": "reviewed"`, writes `pre-commit`, `commit-msg` and `pre-push` hooks into
 * its checkout's hooks folder, and stores where the checking script lives in the checkout's local git
 * config (`review-guard.script`). The hooks name nothing but that setting, so their text gives nothing
 * away, and neither leaves the machine: hooks and local config are never pushed. Running it again writes
 * the same files. A hook file this command didn't write is never overwritten.
 *
 * Exit codes: 0 installed in every reviewed checkout; 1 refused somewhere: a hook file that isn't ours is
 * in the way, or the checkout sets `core.hooksPath`; 2 could not run: no such checkout, git failed, or an
 * unexpected error (`entry.ts`).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEntry } from "./entry.ts";
import { type FactoryConfig, loadFactory } from "./factory-config.ts";
import { ROOT } from "./paths.ts";

/** The first line after the shebang of every hook this command writes: how a rerun knows its own files. */
export const MARKER = "# Installed by guard:install.";
export const HOOKS = ["pre-commit", "commit-msg", "pre-push"] as const;
export const CONFIG_KEY = "review-guard.script";

/** The text of one hook: it finds the script through the checkout's local config and passes git's arguments on. */
export function hookText(stage: (typeof HOOKS)[number]): string {
  return [
    "#!/bin/sh",
    MARKER,
    "# Checks what this commit or push would carry. With no script configured, it refuses.",
    `script="$(git config --get ${CONFIG_KEY})" || { echo "review guard: not configured, so refused" >&2; exit 1; }`,
    `exec node "$script" ${stage} "$(git rev-parse --show-toplevel)" "$@"`,
    "",
  ].join("\n");
}

export class InstallRefused extends Error {}

/** Installs the three hooks in one checkout, pointing them at `script`. Returns the hooks folder. */
export function installHooks(checkout: string, script: string): string {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let hooksPath = "";
  try {
    hooksPath = git("config", "--get", "core.hooksPath");
  } catch {
    // not set: git uses the hooks folder in the git directory
  }
  if (hooksPath) throw new InstallRefused(`${checkout} sets core.hooksPath (${hooksPath}); install there by hand`);
  const relative = git("rev-parse", "--git-path", "hooks");
  const dir = isAbsolute(relative) ? relative : resolve(checkout, relative);
  mkdirSync(dir, { recursive: true });
  // Ours only when it starts with our exact header and is a plain file: a hook that merely mentions the
  // marker, or a symlink whose write would land elsewhere, is someone else's (Qodo on PR 213).
  for (const stage of HOOKS) {
    const file = join(dir, stage);
    if (!existsSync(file)) continue;
    const ours = !lstatSync(file).isSymbolicLink() && readFileSync(file, "utf8").startsWith(`#!/bin/sh\n${MARKER}\n`);
    if (!ours) throw new InstallRefused(`${file} exists and wasn't written by guard:install; move it first`);
  }
  for (const stage of HOOKS) {
    const file = join(dir, stage);
    writeFileSync(file, hookText(stage));
    chmodSync(file, 0o755);
  }
  git("config", "--local", CONFIG_KEY, script.replace(/\\/g, "/"));
  return dir;
}

/**
 * Why the checkout lacks the git-level guard, or undefined when it has it (#242): `core.hooksPath` unset,
 * each of the three hooks present as this command wrote it, and the script setting naming a file that
 * exists. Anything git can't answer counts as missing.
 */
export function guardProblem(checkout: string): string | undefined {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const setting = (key: string) => {
    try {
      return git("config", "--get", key);
    } catch {
      return "";
    }
  };
  try {
    const hooksPath = setting("core.hooksPath");
    if (hooksPath) return `${checkout} sets core.hooksPath (${hooksPath}), so git skips the guard's hooks`;
    const relative = git("rev-parse", "--git-path", "hooks");
    const dir = isAbsolute(relative) ? relative : resolve(checkout, relative);
    for (const stage of HOOKS) {
      const file = join(dir, stage);
      const ours =
        existsSync(file) && !lstatSync(file).isSymbolicLink() && readFileSync(file, "utf8") === hookText(stage);
      if (!ours) return `${checkout} has no guard ${stage} hook`;
      // Git skips a hook it can't run, without a word (Qodo on PR 266).
      if (process.platform !== "win32" && !(statSync(file).mode & 0o111)) return `${file} is not executable`;
    }
    // Git runs the hook from the checkout, so a relative script path is read from there (Qodo on PR 266).
    const configured = setting(CONFIG_KEY);
    const script = configured && resolve(checkout, configured);
    if (!script || !existsSync(script)) return `${checkout}'s guard hooks name no script that exists (${CONFIG_KEY})`;
    // The script must be the guard itself, not any file that happens to exist (Qodo on PR 266).
    const guard =
      basename(script) === "git-guard.ts" && /export function check\(stage/.test(readFileSync(script, "utf8"));
    if (!guard) return `${checkout}'s guard hooks run ${script}, which is not the git-level guard`;
    return undefined;
  } catch (error) {
    return `${checkout} can't be read by git (${(error as Error).message.split("\n")[0]})`;
  }
}

/** True when the checkout has the git-level guard; see `guardProblem`. */
export function guardInstalled(checkout: string): boolean {
  return guardProblem(checkout) === undefined;
}

/** Why each reviewed checkout in `factory` lacks the git-level guard, resolved from `root`; empty when all have it. */
export function unguardedCheckouts(factory: FactoryConfig, root: string = ROOT): string[] {
  return Object.values(factory.repos)
    .filter((repo) => repo.guard === "reviewed")
    .flatMap((repo) => guardProblem(resolve(root, repo.path)) ?? []);
}

function main(): number {
  const script = resolve(ROOT, ".claude", "hooks", "git-guard.ts");
  let code = 0;
  for (const [key, repo] of Object.entries(loadFactory().repos)) {
    if (repo.guard !== "reviewed") continue;
    const checkout = resolve(ROOT, repo.path);
    try {
      if (!existsSync(checkout)) throw new Error(`no checkout at ${checkout}`);
      console.log(`[guard:install] ${key}: hooks in ${installHooks(checkout, script)}`);
    } catch (error) {
      const refused = error instanceof InstallRefused;
      console.error(
        `[guard:install] ${key}: ${refused ? "refused" : "could not install"}: ${(error as Error).message}`,
      );
      code = Math.max(code, refused ? 1 : 2);
    }
  }
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  await runEntry(import.meta.url, main);

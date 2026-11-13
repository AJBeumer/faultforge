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
 * in the way, or the checkout sets `core.hooksPath`; 2 could not run: no such checkout, or git failed.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFactory } from "./factory-config.ts";
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
  for (const stage of HOOKS) {
    const file = join(dir, stage);
    if (existsSync(file) && !readFileSync(file, "utf8").includes(MARKER)) {
      throw new InstallRefused(`${file} exists and wasn't written by guard:install; move it first`);
    }
  }
  for (const stage of HOOKS) {
    const file = join(dir, stage);
    writeFileSync(file, hookText(stage));
    chmodSync(file, 0o755);
  }
  git("config", "--local", CONFIG_KEY, script.replace(/\\/g, "/"));
  return dir;
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main());

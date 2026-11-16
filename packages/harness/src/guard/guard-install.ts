/**
 * Installs the git-level guard in every reviewed checkout named in `factory.json`, the lab's own link check in
 * the checkout marked `"guard": "lab"`, and the private checkout's remote check.
 *
 *   npm run guard:install
 *
 * For each repo with `"guard": "reviewed"`, writes `pre-commit`, `commit-msg` and `pre-push` hooks into
 * its checkout's hooks folder, and stores where the checking script lives in the checkout's local git
 * config (`review-guard.script`). The hooks name nothing but that setting, so their text gives nothing
 * away, and neither leaves the machine: hooks and local config are never pushed. In the lab it writes
 * `pre-commit`, `commit-msg` and `pre-push`, which refuse a link to a reviewed repo's issue or PR in a commit
 * message made or pushed there, and a copy of private storage in a commit. In the private checkout (`private/`,
 * when it is a git checkout) it writes `pre-push` only, and records the `origin` URL in `review-guard.origin`:
 * a push to any other remote or URL is refused, so the private history goes nowhere else. Running it again
 * writes the same files. A hook file this command didn't write is never overwritten.
 *
 * It takes no arguments, and runs only from this repository's main checkout: an unknown flag or extra
 * argument, or a run from a linked worktree, is refused before anything is written, naming the main
 * checkout when that is why. Otherwise a mistyped flag or the wrong folder could silently re-point the
 * git-level guard of all three repositories to a worktree that won't be there later.
 *
 * Exit codes: 0 installed in every reviewed checkout, the lab and the private checkout; 1 refused: an
 * unknown argument (it takes none), a run from a linked worktree instead of the main checkout, a hook file
 * that isn't ours is in the way, or the checkout sets `core.hooksPath`; 2 could not run: no such checkout,
 * git failed, or an unexpected error, even while loading (`npm run guard:install` runs `guard-install-cli.ts`).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type FactoryConfig, loadFactory } from "../shared/factory-config.ts";
import { privateDir, ROOT } from "../shared/paths.ts";

/** The first line after the shebang of every hook this command writes: how a rerun knows its own files. */
export const MARKER = "# Installed by guard:install.";
export const HOOKS = ["pre-commit", "commit-msg", "pre-push"] as const;
/** The lab's hooks: its commits may say anything except link a reviewed repo's issue or PR. */
export const LAB_HOOKS = ["pre-commit", "commit-msg", "pre-push"] as const;
/** The private checkout's hook: its history goes only to the origin recorded at install. */
export const PRIVATE_HOOKS = ["pre-push"] as const;
/** Which hooks a checkout gets: a reviewed repo's full guard, the lab's link check, or the private remote check. */
export type Role = "reviewed" | "lab" | "private";
const hooksFor = (role: Role): readonly (typeof HOOKS)[number][] =>
  role === "lab" ? LAB_HOOKS : role === "private" ? PRIVATE_HOOKS : HOOKS;
export const CONFIG_KEY = "review-guard.script";
/** Where the private checkout's `origin` pointed when the guard was installed: the one place its history goes. */
export const ORIGIN_KEY = "review-guard.origin";

/**
 * The text of one hook: it finds the script through the checkout's local config and passes git's arguments on.
 * In the lab it names the lab's stage (`lab-pre-commit`, `lab-commit-msg`, `lab-pre-push`).
 */
export function hookText(stage: (typeof HOOKS)[number], role: Role = "reviewed"): string {
  return [
    "#!/bin/sh",
    MARKER,
    "# Checks what this commit or push would carry. With no script configured, it refuses.",
    `script="$(git config --get ${CONFIG_KEY})" || { echo "review guard: not configured, so refused" >&2; exit 1; }`,
    `exec node "$script" ${role === "reviewed" ? "" : `${role}-`}${stage} "$(git rev-parse --show-toplevel)" "$@"`,
    "",
  ].join("\n");
}

export class InstallRefused extends Error {}

/** Installs the role's hooks in one checkout, pointing them at `script`. Returns the hooks folder. */
export function installHooks(checkout: string, script: string, role: Role = "reviewed"): string {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let hooksPath = "";
  try {
    hooksPath = git("config", "--get", "core.hooksPath");
  } catch {
    // Not set: git uses the hooks folder in the git directory.
  }
  if (hooksPath) throw new InstallRefused(`${checkout} sets core.hooksPath (${hooksPath}); install there by hand`);
  // Read before anything is written, so a checkout with no origin gets no hooks.
  let origin = "";
  if (role === "private") {
    try {
      origin = git("remote", "get-url", "--push", "origin");
    } catch {
      throw new InstallRefused(`${checkout} has no origin remote, so there is no place its history may go`);
    }
  }
  const relative = git("rev-parse", "--git-path", "hooks");
  const dir = isAbsolute(relative) ? relative : resolve(checkout, relative);
  mkdirSync(dir, { recursive: true });
  // Ours only when it starts with our exact header and is a plain file: a hook that merely mentions the
  // marker, or a symlink whose write would land elsewhere, is someone else's.
  for (const stage of hooksFor(role)) {
    const file = join(dir, stage);
    if (!existsSync(file)) continue;
    const ours = !lstatSync(file).isSymbolicLink() && readFileSync(file, "utf8").startsWith(`#!/bin/sh\n${MARKER}\n`);
    if (!ours) throw new InstallRefused(`${file} exists and wasn't written by guard:install; move it first`);
  }
  for (const stage of hooksFor(role)) {
    const file = join(dir, stage);
    writeFileSync(file, hookText(stage, role));
    chmodSync(file, 0o755);
  }
  git("config", "--local", CONFIG_KEY, script.replace(/\\/g, "/"));
  if (role === "private") git("config", "--local", ORIGIN_KEY, origin);
  return dir;
}

/**
 * Why the checkout lacks the git-level guard, or undefined when it has it: `core.hooksPath` unset,
 * each of the three hooks present as this command wrote it, and the script setting naming a file that
 * exists. Anything git can't answer counts as missing.
 */
export function guardProblem(checkout: string, role: Role = "reviewed"): string | undefined {
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
    for (const stage of hooksFor(role)) {
      const file = join(dir, stage);
      const ours =
        existsSync(file) && !lstatSync(file).isSymbolicLink() && readFileSync(file, "utf8") === hookText(stage, role);
      if (!ours) return `${checkout} has no guard ${stage} hook`;
      // Git silently skips a hook it can't run.
      if (process.platform !== "win32" && !(statSync(file).mode & 0o111)) return `${file} is not executable`;
    }
    // Git runs the hook from the checkout, so a relative script path is read from there.
    const configured = setting(CONFIG_KEY);
    const script = configured && resolve(checkout, configured);
    if (!script || !existsSync(script)) return `${checkout}'s guard hooks name no script that exists (${CONFIG_KEY})`;
    // The script must be the guard itself, not any file that happens to exist.
    const guard =
      basename(script) === "git-guard.ts" && /export function check\(stage/.test(readFileSync(script, "utf8"));
    if (!guard) return `${checkout}'s guard hooks run ${script}, which is not the git-level guard`;
    if (role === "private" && !setting(ORIGIN_KEY)) return `${checkout} has no recorded origin (${ORIGIN_KEY})`;
    return undefined;
  } catch (error) {
    return `${checkout} can't be read by git (${(error as Error).message.split("\n")[0]})`;
  }
}

/** True when the checkout has the git-level guard; see `guardProblem`. */
export function guardInstalled(checkout: string): boolean {
  return guardProblem(checkout) === undefined;
}

/**
 * Why each reviewed checkout in `factory` lacks the git-level guard, or the lab its link check, resolved from
 * `root`, and the private checkout `priv` its remote check when it is a checkout; empty when all have them. A caller that has the private checkout passes it.
 */
export function unguardedCheckouts(factory: FactoryConfig, root: string = ROOT, priv?: string): string[] {
  const problems = Object.values(factory.repos).flatMap(
    (repo) => guardProblem(resolve(root, repo.path), repo.guard) ?? [],
  );
  const privateProblem = priv && existsSync(join(priv, ".git")) ? guardProblem(priv, "private") : undefined;
  return privateProblem ? [...problems, privateProblem] : problems;
}

/**
 * `checkout`'s own git folder (a worktree's `.git` file names it) and its repo's main one (its `commondir`
 * file), read the same way git resolves them: a plain `.git` folder is both; a linked worktree's `.git` file
 * points elsewhere, and that folder's `commondir` file names the main checkout's.
 */
function gitFolders(checkout: string): { own: string; common: string } {
  const dotGit = join(checkout, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return { own: dotGit, common: dotGit };
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim() ?? "";
    const own = isAbsolute(pointer) ? pointer : resolve(checkout, pointer);
    const common = join(own, "commondir");
    return { own, common: existsSync(common) ? resolve(own, readFileSync(common, "utf8").trim()) : own };
  } catch {
    return { own: dotGit, common: dotGit };
  }
}

/** The repository's main checkout, when `checkout` is instead a linked worktree; undefined when it already is one. */
export function mainCheckout(checkout: string): string | undefined {
  const { own, common } = gitFolders(checkout);
  return resolve(own) === resolve(common) ? undefined : dirname(common);
}

/** The command: `guard-install-cli.ts` runs it, so an unexpected error, even while loading, is exit 2. */
export function main(argv: string[] = []): number {
  return guardInstall(argv, ROOT, resolve(ROOT, ".claude", "hooks", "git-guard.ts"), privateDir());
}

/**
 * The full command against `root` and `script` instead of this process's own, so a test can run it against a
 * throwaway checkout: an unknown argument (it takes none) or a run from `root` as a linked worktree instead of
 * its repo's main checkout is refused before anything is written; otherwise every checkout `loadFactory()`
 * marks reviewed or lab, resolved from `root`, gets the hooks (`installAll`).
 */
export function guardInstall(argv: string[], root: string, script: string, priv?: string): number {
  if (argv.length) {
    console.error(`usage: npm run guard:install   (it takes no arguments, got "${argv.join(" ")}")`);
    return 1;
  }
  const elsewhere = mainCheckout(root);
  if (elsewhere) {
    console.error(`[guard:install] refused: run this from the main checkout (${elsewhere}), not this worktree`);
    return 1;
  }
  return installAll(loadFactory(), root, script, priv);
}

/**
 * Installs the hooks in every checkout `factory` marks reviewed or lab, resolved from `root`, and in the private
 * checkout `priv` when it is one (a public clone has none), pointing them at `script`. Returns the command's exit
 * code.
 */
export function installAll(factory: FactoryConfig, root: string, script: string, priv?: string): number {
  let code = 0;
  const targets: [string, string, Role][] = Object.entries(factory.repos)
    .filter(([, repo]) => repo.guard === "reviewed" || repo.guard === "lab")
    .map(([key, repo]) => [key, resolve(root, repo.path), repo.guard]);
  // Only its own checkout: a private folder that isn't one would borrow the lab's hooks folder.
  if (priv && existsSync(join(priv, ".git"))) targets.push(["private", priv, "private"]);
  for (const [key, checkout, role] of targets) {
    try {
      if (!existsSync(checkout)) throw new Error(`no checkout at ${checkout}`);
      console.log(`[guard:install] ${key}: hooks in ${installHooks(checkout, script, role)}`);
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

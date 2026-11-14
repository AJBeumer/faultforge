/**
 * How the runner reaches the private repo, and where a target ticket's agent must not (AUD-H2, #284).
 *
 * On the owner's PC the private repo is the checkout at `<lab>/private`. In CI no checkout exists until the
 * runner makes one: `factory.yml` no longer checks it out before the tick, so a target ticket's agent runs on
 * a VM with no private content on disk. The runner clones it into the runs folder for its own steps (Qodo's
 * state before the agent, the evidence after it) and removes the clone again; a lab ticket's run gets it at
 * `<lab>/private`, as before, because its agent saves evidence there.
 */
import { cpSync, existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { type FactoryConfig, repoConfig } from "./factory-config.ts";
import { git, gitLong } from "./factory-exec.ts";
import type { RunMode } from "./factory-workspace.ts";
import { ROOT as LAB_ROOT } from "./paths.ts";

/** The private repo's `owner/name`, which the CI runner clones; the workflow sets it for the tick's steps. */
export const PRIVATE_REPO_ENV = "FAULTFORGE_PRIVATE_REPO";

/** The private repo's clone URL in CI, from `FAULTFORGE_PRIVATE_REPO`. */
export function privateUrl(env: NodeJS.ProcessEnv = process.env): string {
  const name = env[PRIVATE_REPO_ENV];
  if (!name || !/^[\w.-]+\/[\w.-]+$/.test(name))
    throw new Error(`${PRIVATE_REPO_ENV} must name the private repo (owner/name) for a CI run`);
  return `https://github.com/${name}.git`;
}

/**
 * Copies a target ticket's evidence folder into the private worktree the runner made after the agent ended.
 * Links are not followed or copied: one could point at a file the agent may not publish.
 */
export function copyEvidence(from: string, to: string): void {
  if (!existsSync(from)) return;
  cpSync(from, to, { recursive: true, force: true, filter: (path) => !lstatSync(path).isSymbolicLink() });
}

/** True when the ticket's repo is a reviewed one: its run gets no private checkout. */
export function isReviewedTicket(factory: FactoryConfig, repoKey: string): boolean {
  return repoConfig(factory, repoKey).guard === "reviewed";
}

/**
 * The private checkouts a target ticket's agent must not read, for its policy hook: the owner's (or the
 * workflow's) `<lab>/private`, the private folder the runner's environment names, and the runner's own clone in
 * the runs folder. None for a lab ticket, whose agent works in `<lab>/private`.
 */
export function privateCheckoutsFor(
  factory: FactoryConfig,
  repoKey: string,
  runs: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isReviewedTicket(factory, repoKey)) return [];
  // The whole runs folder: the runner's clone, a Qodo-state worktree kept after a failed push, and other runs'
  // leftovers all sit there (Qodo on PR 288). The run's own folder inside it stays its own.
  const paths = [join(LAB_ROOT, "private"), runs];
  if (env.FAULTFORGE_PRIVATE_DIR) paths.push(resolve(env.FAULTFORGE_PRIVATE_DIR));
  return [...new Set(paths)];
}

/** The runner's way to the private repo in one mode. */
export interface PrivateAccess {
  /** A checkout the runner may add worktrees from: `<lab>/private`, or in CI a clone made on demand. */
  source(): string;
  /** Removes a clone `source()` made, so nothing private stays on disk; nothing on the owner's PC. */
  drop(): void;
  /** The private repo's `main` on GitHub now. */
  main(): string;
  /** Private content still on disk that a target ticket's agent could read, after `drop()`. */
  leftovers(): string[];
}

/** The private repo's access for `mode`, with `privateRepo` its fixed `<lab>/private` folder. */
export function privateAccess(
  mode: RunMode,
  privateRepo: string,
  runs: string,
  env: NodeJS.ProcessEnv = process.env,
): PrivateAccess {
  const clone = join(runs, "private-source");
  if (mode === "local") {
    return {
      source: () => privateRepo,
      drop: () => {},
      main: () => {
        gitLong(privateRepo, "fetch", "--quiet", "origin", "main");
        return git(privateRepo, "rev-parse", "origin/main");
      },
      leftovers: () => [],
    };
  }
  const url = () => privateUrl(env);
  return {
    source: () => {
      if (existsSync(join(privateRepo, ".git"))) return privateRepo;
      if (!existsSync(join(clone, ".git"))) gitLong(runs, "clone", "--quiet", url(), clone);
      return clone;
    },
    drop: () => rmSync(clone, { recursive: true, force: true }),
    main: () => git(runs, "ls-remote", url(), "refs/heads/main").split(/\s/)[0] ?? "",
    leftovers: () => {
      const found = [privateRepo, clone].filter((dir) => existsSync(join(dir, ".git")));
      // A Qodo-state worktree left because its push failed holds a whole private checkout.
      if (existsSync(runs)) {
        for (const entry of readdirSync(runs)) {
          const tree = join(runs, entry, "private");
          if (entry.startsWith("qodo-check-") && existsSync(join(tree, ".git"))) found.push(tree);
        }
      }
      return found;
    },
  };
}

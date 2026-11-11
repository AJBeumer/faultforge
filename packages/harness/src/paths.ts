/**
 * Where everything lives, resolved once: the repository root, private storage, the evidence folder
 * and the folder the factory runner keeps its scratch worktrees in. Every script that needs one of
 * these imports it from here, instead of computing its own copy.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type FactoryConfig, loadFactory } from "./factory-config.ts";

/** This repository's root, in every checkout: three levels up from this module. */
export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** `<root>/<factory.evidence>`: where review-wait, revert-check, rules-evidence, factory-tick and
 * factory-timeline save and read saved reviews, revert checks and run logs. */
export function evidenceDir(factory: FactoryConfig = loadFactory(), root: string = ROOT): string {
  return resolve(root, factory.evidence);
}

/**
 * Private storage: `FAULTFORGE_PRIVATE_DIR` when set, else the parent of the evidence folder
 * (`private/` by default, since `factory.json`'s evidence is `private/raw-artifacts`). `factory` is
 * only read when `FAULTFORGE_PRIVATE_DIR` is unset, so a caller that already has one path never pays
 * for a second `loadFactory()`, and a test that sets the variable never needs a real `factory.json`.
 */
export function privateDir(env: NodeJS.ProcessEnv = process.env, factory?: FactoryConfig, root?: string): string {
  return resolve(env.FAULTFORGE_PRIVATE_DIR ?? dirname(evidenceDir(factory, root)));
}

/** Where the factory runner keeps a run's live log and scratch worktrees, outside every checkout. */
export function runsDir(root: string = ROOT): string {
  return resolve(process.env.FAULTFORGE_RUNS_DIR ?? join(root, "..", "faultforge-runs"));
}

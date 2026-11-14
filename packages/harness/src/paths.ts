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
 * Private storage for the current process's own checkout: `FAULTFORGE_PRIVATE_DIR` when set, else the
 * parent of the evidence folder (`private/` by default, since `factory.json`'s evidence is
 * `private/raw-artifacts`). `factory` is only read when `FAULTFORGE_PRIVATE_DIR` is unset, so a caller
 * that already has one path never pays for a second `loadFactory()`, and a test that sets the variable
 * never needs a real `factory.json`.
 *
 * Deliberately takes no `root`: a caller working against some other, explicit root (a worktree, a test
 * fixture) must derive its private directory from that root directly (`dirname(evidenceDir(factory,
 * root))`), never from this process's own `FAULTFORGE_PRIVATE_DIR` — otherwise the override redirects
 * reads and writes away from the root the caller actually meant (Qodo on PR 154).
 */
export function privateDir(env: NodeJS.ProcessEnv = process.env, factory?: FactoryConfig): string {
  return resolve(env.FAULTFORGE_PRIVATE_DIR ?? dirname(evidenceDir(factory)));
}

/** Where the factory runner keeps a run's live log and scratch worktrees, outside every checkout. */
export function runsDir(root: string = ROOT): string {
  return resolve(process.env.FAULTFORGE_RUNS_DIR ?? join(root, "..", "faultforge-runs"));
}

/** A case's id: `FF-` and four digits. Checked before it names a file (`<id>.json`), so `../x` can name none. */
export const CASE_ID = /^FF-\d{4}$/;

/** True when `id` is a case id; otherwise says why on `error`, as `tool`, and is false (#299). */
export function caseIdOk(id: string, tool: string, error: (line: string) => void): boolean {
  if (CASE_ID.test(id)) return true;
  error(`${tool}: a case id is FF- and four digits, not ${JSON.stringify(id.slice(0, 40))}`);
  return false;
}

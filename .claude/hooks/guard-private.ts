/**
 * The bug templates that exist only in private storage, read at run time, and a test for text that names
 * one (AUD-H1). A template's id says what its bug is, so naming one in a public post before its case is
 * reviewed hands the reviewer the answer. The ids are folder names under the private templates folder,
 * minus those already released to `templates/seed/`. They are never written into this repo and never
 * printed: a denial says only that a private template was named.
 *
 * The private folder is `FAULTFORGE_PRIVATE_DIR` when set, else the parent of `factory.json`'s evidence
 * folder (`private/` by default), as `packages/harness/src/paths.ts` resolves it. Where there is no private
 * folder (public CI, a fresh clone) there is nothing to protect, so the check is skipped.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizeLookalikes } from "../../packages/harness/src/neutral.ts";
import { checkoutAt, within } from "./guard-repos.ts";
import { blankQuoted, gitSteps, quotedMask } from "./shell-scan.ts";

const LAB_ROOT = join(import.meta.dirname, "../..");

/**
 * Folder names directly under `dir`, or none when it doesn't exist. A folder that exists but can't be read
 * throws: the guard then refuses, rather than treat unreadable ids as none (Qodo on PR 265).
 */
function folders(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** Private storage, resolved as paths.ts does, without importing it (the hook keeps its imports small). */
export function privateRoot(env: NodeJS.ProcessEnv, labRoot = LAB_ROOT): string {
  if (env.FAULTFORGE_PRIVATE_DIR) return resolve(env.FAULTFORGE_PRIVATE_DIR);
  let evidence = "private/raw-artifacts";
  try {
    const configured = JSON.parse(readFileSync(join(labRoot, "factory.json"), "utf8")).evidence;
    if (typeof configured === "string" && configured) evidence = configured;
  } catch {
    // the default
  }
  return dirname(resolve(labRoot, evidence));
}

/** The ids of templates that are in private storage and not yet in `templates/seed/`. */
export function privateTemplateIds(env: NodeJS.ProcessEnv, labRoot = LAB_ROOT): string[] {
  const dir = join(privateRoot(env, labRoot), "templates");
  if (!existsSync(dir)) return [];
  const released = new Set(folders(join(labRoot, "templates", "seed")).map((id) => id.toLowerCase()));
  return folders(dir).filter((id) => !released.has(id.toLowerCase()));
}

/**
 * A test for text that names any of `ids`: case-insensitive, as a whole word (letters or digits on either
 * side make it another word), with `-`, `_`, `.` or a space between the id's parts all counting. Look-alike
 * letters and invisible characters are normalised first. Undefined when there are no ids.
 */
export function privateIdMatcher(ids: string[]): ((text: string) => boolean) | undefined {
  if (!ids.length) return undefined;
  const alternatives = ids.map((id) =>
    id
      .split(/[-_.\s]+/)
      .filter(Boolean)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[-_.\\s]?"),
  );
  const pattern = new RegExp(`(?<![a-z0-9])(?:${alternatives.join("|")})(?![a-z0-9])`, "i");
  return (text) => pattern.test(normalizeLookalikes(text));
}

/** The denial, which never repeats the id. */
export const PRIVATE_ID_REASON =
  "This would name a bug template that is still private, in a post anyone (the reviewer included) can read. Leave the template's name out; describe the work instead.";

/** The command's steps, split at `;`, `&`, `|` and new lines outside quoted text, each trimmed. */
function steps(command: string): string[] {
  const quoted = quotedMask(command);
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < command.length; i++) {
    if (!quoted[i] && /[;&|\n]/.test(command[i] ?? "")) {
      parts.push(command.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(command.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * True when every write in the command stays in private storage, where template ids belong: each git
 * commit, push, tag or note runs there (its `-C`, or the folder the command has moved to), and any gh or
 * API call names, in `destinations`, only the repo the private checkout's own remote points at (by owner and
 * name, read from its git config: a repo elsewhere that merely shares the name is public as far as the guard
 * knows; Qodo on PR 265). Anything else, or anything unclear, is a public post.
 */
export function onlyPrivateRepo(command: string, cwd: string, root: string, destinations: string[]): boolean {
  // Only the private folder's own checkout counts: a plain folder would borrow the lab's remotes (Qodo on PR 265).
  const found = checkoutAt(root);
  const own = found && within(found.root, root) ? found.remotes : [];
  // Every destination named anywhere, a URL given to git included, must be the private repo (Qodo on PR 265).
  if (destinations.some((d) => !own.includes(d.toLowerCase()))) return false;
  // Words in a message don't run: only a tool outside quoted text needs a destination (Qodo on PR 265).
  const tools = blankQuoted(command);
  if (/\b(?:gh|curl|wget|Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\b/i.test(tools) && !destinations.length)
    return false;
  // A destination the shell builds (`--repo "$X"`) can't be known here (Qodo on PR 265).
  if (/(?:--repo|\s-R)[\s=]*["']?[$`%]|\bGH_REPO\s*=\s*["']?[$`%]/.test(command)) return false;
  // Anything that points git at another folder or repository makes the step's target unclear.
  if (/\bGIT_(?:DIR|WORK_TREE)\b|--git-dir|--work-tree/i.test(tools)) return false;
  let here = cwd;
  let wrote = false;
  // Split only at operators outside quoted text: a `cd` inside a message moves nowhere (Qodo on PR 265).
  for (const step of steps(command)) {
    const move = /^(?:cd|pushd|Set-Location|sl)\s+(?:-(?:Literal)?Path\s+)?["']?([^"'\s]+)/i.exec(step);
    if (move?.[1]) {
      if (/[$`%]|^~/.test(move[1])) return false;
      here = resolve(here, move[1]);
      continue;
    }
    if (!gitSteps(step, /\b(?:commit|push|tag|notes)\b/).length) continue;
    wrote = true;
    // Each `-C` is resolved from the one before, as git does (Qodo on PR 265).
    let dir = here;
    for (const m of step.matchAll(/\s-C\s*["']?([^"'\s]+)/g)) {
      if (/[$`%]|^~/.test(m[1] ?? "")) return false;
      dir = resolve(dir, m[1] ?? "");
    }
    if (!within(dir, root)) return false;
  }
  return wrote || destinations.length > 0;
}

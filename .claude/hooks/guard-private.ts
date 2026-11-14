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
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { normalizeLookalikes } from "../../packages/harness/src/neutral.ts";
import { gitSteps } from "./shell-scan.ts";

const LAB_ROOT = join(import.meta.dirname, "../..");

/** Folder names directly under `dir`, or none when it doesn't exist or can't be read. */
function folders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
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

/** True when `dir` is `root` or inside it. Case-blind on Windows, where folder names are. */
function inside(dir: string, root: string): boolean {
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = relative(fold(root), fold(dir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * True when every write in the command stays in private storage, where template ids belong: each git
 * commit, push, tag or note runs there (its `-C`, or the folder the command has moved to), and any gh or
 * API call names only the private repo. Anything else, or anything unclear, is a public post.
 */
export function onlyPrivateRepo(command: string, cwd: string, root: string): boolean {
  const destinations = [...command.matchAll(/(?:--repo|\s-R)[\s=]*["']?([\w.-]+\/[\w.-]+)/g)].map((m) => m[1] ?? "");
  if (/\b(?:gh|curl|wget|Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\b/i.test(command)) {
    if (!destinations.length || destinations.some((d) => !/\/faultforge-private$/i.test(d))) return false;
  }
  let here = cwd;
  let wrote = false;
  for (const step of command.split(/&&|\|\||[;|\n]/).map((s) => s.trim())) {
    const move = /^(?:cd|pushd|Set-Location|sl)\s+(?:-(?:Literal)?Path\s+)?["']?([^"'\s]+)/i.exec(step);
    if (move?.[1]) {
      if (/[$`%~]/.test(move[1])) return false;
      here = resolve(here, move[1]);
      continue;
    }
    if (!gitSteps(step, /\b(?:commit|push|tag|notes)\b/).length) continue;
    wrote = true;
    const at = /\bgit\s+-C\s*["']?([^"'\s]+)/.exec(step)?.[1];
    if (at && /[$`%~]/.test(at)) return false;
    if (!inside(at ? resolve(here, at) : here, root)) return false;
  }
  return wrote || destinations.length > 0;
}

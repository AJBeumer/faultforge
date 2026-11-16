/**
 * The bug templates that exist only in private storage, read at run time, and a test for text that names
 * one (AUD-H1). A template's id says what its bug is, so naming one in a public post before its case is
 * reviewed hands the reviewer the answer. The ids are folder names under the private templates folder,
 * minus those already released to `templates/seed/`. They are never written into this repo and never
 * printed: a denial says only that a private template was named.
 *
 * The private folder is `FAULTFORGE_PRIVATE_DIR` when set, else the parent of `factory.json`'s evidence
 * folder (`private/` by default), as `packages/harness/src/shared/paths.ts` resolves it. Where there is no private
 * folder (public CI, a fresh clone) there is nothing to protect, so the check is skipped.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { leetReadings, readerViews } from "../shared/harness-bridge.ts";
import { checkoutAt, esc, githubRepos, LAB_ROOT, within } from "../shared/repos.ts";
import { blankQuoted, gitSteps, splitSteps } from "../shell/scan.ts";

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
  // A target ticket's run names the owner's private folder for this hook alone: project scripts read
  // FAULTFORGE_PRIVATE_DIR, and must not reach it (Qodo on PR 288).
  if (env.FAULTFORGE_GUARD_PRIVATE_DIR) return resolve(env.FAULTFORGE_GUARD_PRIVATE_DIR);
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

/**
 * Every URL git would push to (or with `push` false, fetch from) for `remote` in `dir`: a remote may have several
 * push URLs, and git pushes to all of them (Qodo on PR 333). Empty when it has none.
 */
export function pushUrls(dir: string, remote: string, push = true): string[] {
  const r = spawnSync("git", ["-C", dir, "remote", "get-url", "--all", ...(push ? ["--push"] : []), remote], {
    encoding: "utf8",
    timeout: 4000,
    windowsHide: true,
  });
  return r.status === 0
    ? r.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

/**
 * The GitHub repo (owner/name, lower case) the private checkout's `origin` names, as a list: empty when `root`
 * holds no checkout of its own (a plain folder would borrow the lab's remotes) or it has no origin on GitHub.
 */
export function privateOrigin(root: string): string[] {
  const found = checkoutAt(root);
  return found && within(found.root, root) ? agreedRepos(found.root, "origin") : [];
}

/**
 * The GitHub repos a remote names when its fetch URL and every push URL agree, or none: a second push URL to
 * another repo would make that repo "the remote" too, and git pushes to all of them (Qodo on PR 333).
 */
export function agreedRepos(dir: string, remote: string): string[] {
  const fetched = pushUrls(dir, remote, false).flatMap(githubRepos);
  const pushed = pushUrls(dir, remote);
  const agree = pushed.every((url) => {
    const repos = githubRepos(url);
    return repos.length > 0 && repos.every((repo) => fetched.includes(repo));
  });
  return agree ? fetched : [];
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
 * side make it another word), with any separator between the id's parts counting (privateIdPattern). Look-alike
 * letters, invisible characters and markup that renders as nothing are normalised first (`readerViews`). Undefined when there are no ids.
 */
export function privateIdMatcher(ids: string[]): ((text: string) => boolean) | undefined {
  if (!ids.length) return undefined;
  const pattern = privateIdPattern(ids);
  // Leetspeak too (#285): the text and the ids are read the same way, so `x-s3cr3t-v1` meets `x-secret-v1`.
  const folded = privateIdPattern(ids.flatMap(leetReadings));
  // Written backwards too (re-grade 6): `1v-terces-x` is `x-secret-v1` read from the end.
  return (text) =>
    [...new Set([text, percentDecoded(text)].flatMap((each) => [each, [...each].reverse().join("")]))].some((each) =>
      // As written and as markdown renders it (re-grade 7): a comment, an entity or emphasis can't split an id.
      readerViews(each).some(
        (seen) => pattern.test(seen) || leetReadings(seen).some((reading) => folded.test(reading)),
      ),
    );
}

/**
 * The text with its percent-escapes decoded, as a URL or an API reads them (re-grade 3): `x%2Dsecret` is
 * `x-secret`. Decoded up to three times, so a doubly escaped `%252D` is read too.
 */
export function percentDecoded(text: string): string {
  let out = text;
  for (let round = 0; round < 3 && /%[0-9a-f]{2}/i.test(out); round++) {
    out = out.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
  return out;
}

/**
 * The whole-word pattern for `ids`, their parts joined by any separator (#299): none, or up to three marks that
 * are not letters or digits, in any mix, so `x--secret--v1`, `x_secret.v1` and `x - secret / v1` all count.
 */
function privateIdPattern(ids: string[]): RegExp {
  const alternatives = ids.map((id) =>
    id
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .map(esc)
      .join("[^\\p{L}\\p{N}]{0,3}"),
  );
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

/** The denial, which never repeats the id. */
export const PRIVATE_ID_REASON =
  "This would name a bug template that is still private, in a post anyone (the reviewer included) can read. Leave the template's name out; describe the work instead.";

/**
 * True when every write in the command stays in private storage, where template ids belong: each git
 * commit, push, tag or note runs there (its `-C`, or the folder the command has moved to), and any gh or
 * API call names, in `destinations`, only the repo the private checkout's own remote points at (by owner and
 * name, read from its git config: a repo elsewhere that merely shares the name is public as far as the guard
 * knows; Qodo on PR 265). Anything else, or anything unclear, is a public post.
 */
export function onlyPrivateRepo(command: string, cwd: string, root: string, destinations: string[]): boolean {
  // Only the private folder's own checkout counts: a plain folder would borrow the lab's remotes (Qodo on PR 265).
  // Its `origin` only: another remote in it (the lab, say) is not private storage (re-grade 6).
  const own = privateOrigin(root);
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
  for (const step of splitSteps(command)) {
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

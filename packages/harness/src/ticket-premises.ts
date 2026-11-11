/**
 * A ticket's premises: the repository paths, file names, npm scripts and exported functions it names
 * in backticks as things that already exist. Each one is checked against a checkout before the factory
 * builds the ticket, so a work order written against a file that was deleted, a helper that no longer
 * exists or a script that never existed is reported as "stale premise" instead of being built on (#147).
 *
 * What counts as a premise: a backtick token outside fenced code blocks and `<details>` blocks (kept
 * original wording), outside the ticket's deliverable sections (the first required section and the
 * checklist, which describe what will exist afterwards), and not introduced by "new", "create", "add"
 * or "gain" in the same sentence. A path with a `/` must exist at that path; a bare file name such as
 * `inject.ts` must exist somewhere in the checkout. A premise that the ticket's own repo lacks but a
 * sibling repo of the factory has (a lab ticket naming the target's `INVARIANTS.md`) is not stale.
 * Paths under `private/` are skipped: that repository isn't part of a CI checkout. Used by
 * `ticket-ready.ts`; no network.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type PremiseKind = "path" | "file" | "script" | "function";
export type Premise = { token: string; kind: PremiseKind };

/** The body without fenced code blocks and `<details>` blocks, so examples and kept wording can't count. */
export function proseOf(body: string): string {
  return body.replace(/^(```|~~~)[\s\S]*?^\1\s*$/gm, "").replace(/<details>[\s\S]*?<\/details>/gi, "");
}

/** A ticket's `###` sections by lower-case name, from its prose. */
export function sectionsOf(body: string): Map<string, string> {
  const parts = new Map<string, string>();
  for (const match of proseOf(body).matchAll(/^###\s+(.+?)\s*$([\s\S]*?)(?=^###\s|(?![\s\S]))/gm)) {
    parts.set((match[1] ?? "").trim().toLowerCase(), (match[2] ?? "").trim());
  }
  return parts;
}

const PATH = /^\.?[\w.@-]+(?:\/[\w.@-]+)+\.[a-z][a-z0-9]*$/i;
/** A bare file name with a source, data or doc extension, such as `inject.ts` or `CLAUDE.md`. */
const FILE = /^[\w.@-]+\.(?:ts|mts|js|mjs|cjs|json|jsonl|md|yml|yaml|txt|sh|ps1)$/i;
const FUNCTION = /^[A-Za-z_$][\w$]*\(\)$/;
const SCRIPT = /^[a-z][\w-]*:[a-z][\w-]*$/;
const NPM_RUN = /^npm run (?:-s )?([\w:-]+)/;
/** Words that announce something the ticket will create, read from the sentence before the token. */
const INTRODUCES = /\b(?:new|creates?|created|adds?|added|gains?|introduces?|introduced|writes?)\b[^`.]*$/i;

/** One premise from one backtick token, or null when the token isn't a checkable claim. */
export function classify(token: string): Premise | null {
  const text = token.trim();
  if (!text || /[<>*\s]/.test(text.replace(/^npm run (?:-s )?/, "")) || text.includes("://")) return null;
  const run = NPM_RUN.exec(text);
  if (run?.[1]) return { token: run[1], kind: "script" };
  const path = text.replace(/:\d+(?:-\d+)?$/, "");
  if (PATH.test(path)) return path.startsWith("private/") ? null : { token: path, kind: "path" };
  if (FILE.test(path)) return { token: path, kind: "file" };
  if (FUNCTION.test(text)) return { token: text.slice(0, -2), kind: "function" };
  if (SCRIPT.test(text)) return { token: text, kind: "script" };
  return null;
}

/**
 * Every premise the ticket states, in order of first appearance. `deliverables` are the section names
 * whose tokens describe the result, not the starting point.
 */
export function premisesOf(body: string, deliverables: string[]): Premise[] {
  const skip = new Set(deliverables.map((name) => name.toLowerCase()));
  const seen = new Set<string>();
  const premises: Premise[] = [];
  for (const [name, text] of sectionsOf(body)) {
    if (skip.has(name)) continue;
    for (const match of text.matchAll(/`([^`\n]+)`/g)) {
      const before = text.slice(Math.max(0, match.index - 80), match.index);
      if (INTRODUCES.test(before)) continue;
      const premise = classify(match[1] ?? "");
      if (!premise) continue;
      const key = `${premise.kind}:${premise.token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      premises.push(premise);
    }
  }
  return premises;
}

const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "private", "coverage"]);

/** Every file under a checkout, skipping dependencies, build output and private storage. */
function allFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) allFiles(full, found);
    else found.push(full);
  }
  return found;
}

/** Names exported as `export function`, `export async function`, `export const` or `export let` in any source file. */
export function exportedNames(checkout: string): Set<string> {
  const names = new Set<string>();
  for (const file of allFiles(checkout).filter((f) => /\.(?:ts|mts|js|mjs)$/.test(f))) {
    for (const match of readFileSync(file, "utf8").matchAll(
      /^export\s+(?:async\s+)?(?:function|const|let)\s+([\w$]+)/gm,
    )) {
      if (match[1]) names.add(match[1]);
    }
  }
  return names;
}

/** The checkout's npm scripts, or an empty set when it has no package.json. */
export function scriptNames(checkout: string): Set<string> {
  const file = join(checkout, "package.json");
  if (!existsSync(file)) return new Set();
  const scripts = (JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  return new Set(Object.keys(scripts));
}

/** Every file name (without its folder) in the checkout. */
export function fileNames(checkout: string): Set<string> {
  return new Set(allFiles(checkout).map((f) => basename(f)));
}

/** What one checkout holds, each list read at most once and only when a premise needs it. */
function holdings(checkout: string) {
  const cache = new Map<string, Set<string>>();
  const lookup = (key: string, load: () => Set<string>): Set<string> => {
    const cached = cache.get(key);
    if (cached) return cached;
    const loaded = load();
    cache.set(key, loaded);
    return loaded;
  };
  return (premise: Premise): boolean => {
    switch (premise.kind) {
      case "path":
        return existsSync(join(checkout, premise.token));
      case "file":
        return lookup("files", () => fileNames(checkout)).has(premise.token);
      case "script":
        return lookup("scripts", () => scriptNames(checkout)).has(premise.token);
      default:
        return lookup("exports", () => exportedNames(checkout)).has(premise.token);
    }
  };
}

/**
 * One problem line per premise no checkout satisfies, in the ticket's order. `siblings` are the other
 * repos' checkouts (those that exist): a premise found there is a cross-repo mention, not a stale one.
 */
export function premiseProblems(premises: Premise[], checkout: string, siblings: string[] = []): string[] {
  const holders = [checkout, ...siblings.filter((dir) => existsSync(dir))].map(holdings);
  const problems: string[] = [];
  for (const premise of premises) {
    if (holders.some((has) => has(premise))) continue;
    problems.push(`stale premise: ${premise.token} (${premise.kind}) not found`);
  }
  return problems;
}

/**
 * A ticket's premises: the repository paths, file names, npm scripts and functions it names in
 * backticks as things that already exist. Each one is checked against `origin/main` of the repo's
 * checkout, the revision an unattended run builds from, before the factory builds the ticket. A work
 * order written against a file that was deleted, a helper that no longer exists or a script that never
 * existed is reported as "stale premise" instead of being built on (#147).
 *
 * What counts as a premise: a backtick token outside fenced code blocks and `<details>` blocks (kept
 * original wording), outside the ticket's deliverable sections (the first required section, the
 * checklist and "Out of scope", which describe what will or will not exist afterwards), and not
 * introduced by "new", "create", "add" or "gain" in the same clause. A path with a `/` must be in
 * main's tree at that path; a bare file name such as `inject.ts` must be in the tree somewhere, or in
 * the private storage folder beside the checkout, which is never committed. A function must be
 * declared, exported or imported somewhere in main's source files. A premise that the ticket's own
 * repo lacks but a sibling repo of the factory has (a lab ticket naming the target's `INVARIANTS.md`)
 * is not stale. Everything is read through `git`, never from the working tree, so the owner's branch
 * and uncommitted files can't change the verdict. Used by `ticket-ready.ts`; no network.
 */
import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export type PremiseKind = "path" | "file" | "script" | "function";
export type Premise = { token: string; kind: PremiseKind };

/** The revision every premise is checked against: what a fresh run checks out. */
export const MAIN_REF = "origin/main";

/** The body without fenced code blocks (indented or not) and `<details>` blocks, so examples and kept wording can't count. */
export function proseOf(body: string): string {
  return body
    .replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm, "")
    .replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, "");
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
const SCRIPT = /^([a-z][\w-]*):[a-z][\w-]*$/;
/** `a:b` tokens that are module specifiers or search qualifiers, never npm scripts. */
const NOT_SCRIPTS = new Set([
  "node",
  "npm",
  "bun",
  "http",
  "https",
  "git",
  "mailto",
  "is",
  "label",
  "state",
  "repo",
  "sort",
  "author",
  "assignee",
  "milestone",
  "type",
  "org",
  "user",
  "no",
  "in",
]);
const NPM_RUN = /^npm run (?:-s )?([\w:-]+)/;
/** Words that announce something the ticket will create, read from the same clause before the token. */
const INTRODUCES = /\b(?:new|creates?|created|adds?|added|gains?|introduces?|introduced|writes?)\b[^`.\n;:]*$/i;

/** One premise from one backtick token, or null when the token isn't a checkable claim. */
export function classify(token: string): Premise | null {
  const text = token.trim();
  const run = NPM_RUN.exec(text);
  if (run?.[1]) return { token: run[1], kind: "script" };
  if (!text || /[<>*\s]/.test(text) || text.includes("://")) return null;
  const path = text.replace(/^\.\//, "").replace(/:\d+(?:-\d+)?$/, "");
  if (PATH.test(path)) return path.startsWith("private/") ? null : { token: path, kind: "path" };
  if (FILE.test(path)) return { token: path, kind: "file" };
  if (FUNCTION.test(text)) return { token: text.slice(0, -2), kind: "function" };
  const script = SCRIPT.exec(text);
  if (script?.[1] && !NOT_SCRIPTS.has(script[1])) return { token: text, kind: "script" };
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

function git(checkout: string, args: string[]): string {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5 * 60_000, // a fetch over the network must not hang the readiness check (audit N-14)
  });
}

/**
 * Fetches the branch behind `ref` (`origin/main`: branch `main` of remote `origin`), so the check reads
 * today's main and not whatever the checkout last fetched. Throws when the fetch fails: a verdict against
 * an old main is worse than no verdict.
 */
export function refreshRef(checkout: string, ref = MAIN_REF): void {
  const [remote, ...branch] = ref.split("/");
  if (!remote || !branch.length) throw new Error(`cannot refresh ${ref}: not a remote-tracking ref`);
  try {
    git(checkout, ["fetch", "--quiet", remote, branch.join("/")]);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n").slice(-2).join(" ").trim() : String(error);
    throw new Error(`could not refresh ${ref} in ${checkout}: ${detail}`);
  }
}

/** Every path in the tree at `ref`, or a clear error when the checkout has no such revision. */
function treePaths(checkout: string, ref: string): string[] {
  try {
    return git(checkout, ["ls-tree", "-r", "--name-only", ref]).split("\n").filter(Boolean);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`cannot read ${ref} in ${checkout}: ${detail}`);
  }
}

const SOURCE_FILE = /\.(?:ts|mts|js|mjs|cjs)$/;
const DECLARATION = /(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;

/** Names in one `export { a, b as c }` or `import { a as b, c }` list: both sides of every alias. */
function bracedNames(list: string): string[] {
  return list
    .split(",")
    .flatMap((part) => part.split(/\s+as\s+/))
    .map((name) => name.replace(/^type\s+/, "").trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

/** The text of every source file at `ref`, read in one `git cat-file --batch` call. */
function sourceTexts(checkout: string, ref: string): string[] {
  const files = treePaths(checkout, ref).filter((path) => SOURCE_FILE.test(path));
  if (!files.length) return [];
  const batch = execFileSync("git", ["-C", checkout, "cat-file", "--batch"], {
    input: files.map((path) => `${ref}:${path}`).join("\n"),
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Each entry is "<sha> <type> <size>\n<content>\n"; a missing object is "<name> missing\n".
  // Sizes are bytes, so the walk is over the raw bytes; each blob is decoded on its own.
  const texts: string[] = [];
  let at = 0;
  while (at < batch.length) {
    const headerEnd = batch.indexOf(0x0a, at);
    if (headerEnd < 0) break;
    const header = batch.toString("utf8", at, headerEnd).split(" ");
    at = headerEnd + 1;
    if (header[1] === "missing") continue;
    const size = Number(header[2]);
    texts.push(batch.toString("utf8", at, at + size));
    at += size + 1;
  }
  return texts;
}

/**
 * Every function-like name a source file at `ref` declares, exports or imports, across line breaks. A
 * ticket that names `main()` (declared, not exported) or `existsSync()` (imported from Node) states a
 * true premise.
 */
function sourceNames(checkout: string, ref: string): Set<string> {
  const names = new Set<string>();
  for (const text of sourceTexts(checkout, ref)) {
    for (const match of text.matchAll(DECLARATION)) if (match[1]) names.add(match[1]);
    for (const match of text.matchAll(/\b(?:export|import)\s*(?:type\s*)?\{([^}]*)\}/g)) {
      if (match[1]) for (const name of bracedNames(match[1])) names.add(name);
    }
    for (const match of text.matchAll(/\bimport\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) {
      if (match[1]) names.add(match[1]);
    }
    for (const match of text.matchAll(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) if (match[1]) names.add(match[1]);
  }
  return names;
}

/** The scripts of `package.json` at `ref`, or none when the checkout has no package.json there. */
function scriptNames(checkout: string, ref: string): Set<string> {
  try {
    const pkg = JSON.parse(git(checkout, ["show", `${ref}:package.json`])) as { scripts?: Record<string, string> };
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return new Set();
  }
}

/** File names under the private storage folder beside a checkout, which git never holds. Symlinks are not followed. */
function privateFileNames(checkout: string, depth = 4): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string, left: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.isDirectory()) {
        if (left > 0) walk(join(dir, entry.name), left - 1);
      } else names.add(entry.name);
    }
  };
  const privateDir = join(checkout, "private");
  if (existsSync(privateDir)) walk(privateDir, depth);
  return names;
}

/** What one checkout holds at `ref`, each list read at most once and only when a premise needs it. */
function holdings(checkout: string, ref: string): (premise: Premise) => boolean {
  const cache = new Map<string, Set<string>>();
  const lookup = (key: string, load: () => Set<string>): Set<string> => {
    const cached = cache.get(key);
    if (cached) return cached;
    const loaded = load();
    cache.set(key, loaded);
    return loaded;
  };
  const paths = () => lookup("paths", () => new Set(treePaths(checkout, ref)));
  return (premise: Premise): boolean => {
    switch (premise.kind) {
      case "path":
        return paths().has(premise.token);
      case "file":
        return (
          lookup("names", () => new Set([...paths()].map((p) => basename(p)))).has(premise.token) ||
          lookup("private", () => privateFileNames(checkout)).has(premise.token)
        );
      case "script":
        return lookup("scripts", () => scriptNames(checkout, ref)).has(premise.token);
      default:
        return lookup("functions", () => sourceNames(checkout, ref)).has(premise.token);
    }
  };
}

/**
 * One problem line per premise no checkout satisfies at `ref`, in the ticket's order, naming where it
 * was looked for. `siblings` are the other repos' checkouts (those that exist): a premise found there
 * is a cross-repo mention, not a stale one. They are touched only when the ticket's own repo lacks a
 * premise, each prepared by `prepare` (a fetch) just before its first read.
 */
export function premiseProblems(
  premises: Premise[],
  checkout: string,
  siblings: string[] = [],
  ref = MAIN_REF,
  prepare: (dir: string) => void = () => {},
): string[] {
  const present = siblings.filter((dir) => existsSync(dir));
  const own = holdings(checkout, ref);
  // A sibling is prepared (fetched) and read only the first time the ticket's own repo lacks a premise.
  let siblingHolders: ((premise: Premise) => boolean)[] | undefined;
  const inSiblings = (premise: Premise): boolean => {
    siblingHolders ??= present.map((dir) => {
      prepare(dir);
      return holdings(dir, ref);
    });
    return siblingHolders.some((has) => has(premise));
  };
  const where = `not found on ${ref} of the ticket's repo${
    present.length ? ` or ${present.length} sibling repo${present.length > 1 ? "s" : ""}` : ""
  }`;
  const problems: string[] = [];
  for (const premise of premises) {
    if (own(premise) || inSiblings(premise)) continue;
    problems.push(`stale premise: ${premise.token} (${premise.kind}) ${where}`);
  }
  return problems;
}

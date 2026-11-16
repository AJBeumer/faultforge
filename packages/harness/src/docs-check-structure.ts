/**
 * The Markdown rules `npm run docs:check` holds the docs to (#354), so a person can find their way in them:
 * no page over 150 lines (the decision log's weekly files excepted), every relative link and heading anchor
 * resolves, and `docs/README.md`, the start page, links every doc under `docs/`.
 *
 * A library for `docs-check.ts`, which runs it and owns the exit codes.
 *
 * Exit codes: none; it is not a script.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

export interface MarkdownFile {
  /** Repository-relative, with `/` separators. */
  path: string;
  text: string;
}

export const MAX_LINES = 150;
export const START_PAGE = "docs/README.md";

/** Every Markdown file git tracks or would track (new and not ignored) under `root`. */
export function markdownFiles(root: string): MarkdownFile[] {
  const listed = spawnSync("git", ["-C", root, "ls-files", "-z", "-co", "--exclude-standard", "--", "*.md"], {
    encoding: "utf8",
  });
  if (listed.status !== 0) throw new Error(`can't list the Markdown files: ${(listed.stderr ?? "").trim()}`);
  const paths = [...new Set(listed.stdout.split("\0").filter(Boolean))];
  return paths
    .filter((path) => existsSync(join(root, path)))
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
}

/** The lines of a Markdown file, with fenced code blocks blanked out (kept as empty lines so counts hold). */
function proseLines(text: string): string[] {
  let fence: string | undefined;
  return text.split(/\r?\n/).map((line) => {
    const mark = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (mark && (!fence || mark.startsWith(fence))) {
      fence = fence ? undefined : mark;
      return "";
    }
    return fence ? "" : line;
  });
}

function lineCount(text: string): number {
  return text.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

/** Pages over the limit: Markdown under `docs/`, at the root and under `.claude/skills/`. */
export function tooLong(files: MarkdownFile[]): string[] {
  const inScope = (p: string) => p.startsWith("docs/") || !p.includes("/") || p.startsWith(".claude/skills/");
  // The decision log's weekly files hold its entries verbatim, so a busy week may run long.
  const weekly = (p: string) => /^docs\/decisions\/[^/]+\.md$/.test(p);
  return files
    .filter((f) => inScope(f.path) && !weekly(f.path) && lineCount(f.text) > MAX_LINES)
    .map((f) => `${f.path}: ${lineCount(f.text)} lines, over the ${MAX_LINES} a page may have`);
}

/** The anchors GitHub gives a Markdown file's headings (and any `<a id>` or `<a name>` in it). */
export function slugs(text: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of proseLines(text)) {
    const heading = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/)?.[1];
    if (heading !== undefined) {
      const base = heading
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/g, "-");
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      out.add(n ? `${base}-${n}` : base);
    }
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1] as string);
  }
  return out;
}

/** Every link target in a file's prose: inline links and reference definitions, outside code. */
function linkTargets(text: string): string[] {
  const targets: string[] = [];
  for (const raw of proseLines(text)) {
    const line = raw.replace(/`[^`]*`/g, "");
    for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) targets.push(m[1] as string);
    const ref = line.match(/^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/);
    if (ref) targets.push(ref[1] as string);
  }
  return targets;
}

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

/** Relative links whose file, folder or heading doesn't exist. */
export function brokenLinks(files: MarkdownFile[], root: string): string[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const anchors = new Map<string, Set<string>>();
  const anchorsOf = (path: string): Set<string> | undefined => {
    if (!anchors.has(path)) {
      const known = byPath.get(path);
      const full = join(root, path);
      const text = known?.text ?? (existsSync(full) ? readFileSync(full, "utf8") : undefined);
      if (text === undefined) return undefined;
      anchors.set(path, slugs(text));
    }
    return anchors.get(path);
  };
  const problems: string[] = [];
  for (const f of files) {
    for (const target of linkTargets(f.text)) {
      if (EXTERNAL.test(target) || target.startsWith("/")) continue;
      const [rawPath = "", anchor] = target.split("#", 2);
      const filePath = decodeURIComponent(rawPath);
      const resolved = filePath ? posix.normalize(posix.join(posix.dirname(f.path), filePath)) : f.path;
      if (resolved.startsWith("../") || !(byPath.has(resolved) || existsSync(join(root, resolved)))) {
        problems.push(`${f.path}: link to ${target}, which doesn't exist`);
        continue;
      }
      if (anchor && resolved.endsWith(".md") && !anchorsOf(resolved)?.has(decodeURIComponent(anchor).toLowerCase())) {
        problems.push(`${f.path}: link to ${target}, which has no such heading`);
      }
    }
  }
  return problems;
}

/** Docs under `docs/` that the start page doesn't link to directly. */
export function unlistedDocs(files: MarkdownFile[]): string[] {
  const start = files.find((f) => f.path === START_PAGE);
  if (!start) return [`${START_PAGE}: missing; it is the docs' start page`];
  const linked = new Set(
    linkTargets(start.text)
      .filter((t) => !EXTERNAL.test(t))
      .map((t) => posix.normalize(posix.join(posix.dirname(START_PAGE), decodeURIComponent(t.split("#")[0] ?? "")))),
  );
  // A link to a folder is a link to its README.md, the page GitHub shows there.
  const listed = (p: string) =>
    linked.has(p) || (p.endsWith("/README.md") && linked.has(p.slice(0, -"README.md".length)));
  return files
    .filter((f) => f.path.startsWith("docs/") && f.path !== START_PAGE && !listed(f.path))
    .map((f) => `${f.path}: not linked from ${START_PAGE}`);
}

/** All three rules, in order: length, links, the start page. */
export function structureProblems(files: MarkdownFile[], root: string): string[] {
  return [...tooLong(files), ...brokenLinks(files, root), ...unlistedDocs(files)];
}

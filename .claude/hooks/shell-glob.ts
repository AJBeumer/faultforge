/**
 * Shell wildcards as the shell would expand them (Qodo on PR 310): brace lists (`{a,b}`) and the `*`, `?` and
 * `[…]` patterns, matched against the folders that exist. Shared by the guard (a gist's or release's files) and
 * the factory policy (a lab run's paths): a wildcard is judged by what it names, not by its spelling.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";

/** True when the word holds a shell wildcard or a brace list. */
export const hasWildcard = (word: string) => /[*?[{]/.test(word);

/** The most paths one word is expanded to before the caller is told it can't be listed. */
export const MAX_MATCHES = 2000;

/** Brace expansion: `a{b,c}d` is `abd` and `acd`, nested lists included, up to `MAX_MATCHES` words. */
export function braces(word: string): string[] {
  const open = word.indexOf("{");
  if (open < 0) return [word];
  let depth = 0;
  const commas: number[] = [];
  for (let i = open; i < word.length; i++) {
    const c = word[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      // A list with no comma (`{x}`) is the shell's literal text: only the rest of the word is expanded.
      if (!commas.length) return braces(word.slice(i + 1)).map((rest) => word.slice(0, i + 1) + rest);
      const cuts = [open, ...commas, i];
      const out: string[] = [];
      for (let k = 0; k + 1 < cuts.length && out.length < MAX_MATCHES; k++) {
        const part = word.slice((cuts[k] ?? 0) + 1, cuts[k + 1]);
        out.push(...braces(word.slice(0, open) + part + word.slice(i + 1)));
      }
      return out.slice(0, MAX_MATCHES);
    } else if (c === "," && depth === 1) commas.push(i);
  }
  return [word];
}

/** A pattern for one path segment: `*` any run, `?` one character, `[…]` (and `[!…]`) a class. */
function segmentPattern(segment: string): RegExp {
  let source = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] ?? "";
    if (c === "*") source += ".*";
    else if (c === "?") source += ".";
    else if (c === "[") {
      const end = segment.indexOf("]", i + 2);
      if (end < 0) source += "\\[";
      else {
        const body = segment
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\");
        source += `[${body}]`;
        i = end;
      }
    } else source += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, process.platform === "win32" ? "is" : "s");
}

/**
 * The existing paths a shell word names from `cwd`, wildcards and brace lists expanded, or undefined when there
 * are more than `MAX_MATCHES` to look at. A dot file counts for `*` too, as reading one more file is harmless.
 */
export function globMatches(word: string, cwd: string): string[] | undefined {
  const found = new Set<string>();
  let looked = 0;
  for (const variant of braces(word)) {
    const full = isAbsolute(variant) ? variant : resolve(cwd, variant);
    const root = parse(full).root;
    let current = [root];
    for (const segment of full
      .slice(root.length)
      .split(/[\\/]+/)
      .filter(Boolean)) {
      if (!/[*?[]/.test(segment)) {
        current = current.map((dir) => join(dir, segment));
        continue;
      }
      const pattern = segmentPattern(segment);
      const next: string[] = [];
      for (const dir of current) {
        let entries: string[] = [];
        try {
          if (statSync(dir).isDirectory()) entries = readdirSync(dir);
        } catch {
          // no such folder: nothing matches in it
        }
        looked += entries.length;
        if (looked > MAX_MATCHES) return undefined;
        for (const entry of entries) if (pattern.test(entry)) next.push(join(dir, entry));
      }
      current = next;
    }
    for (const path of current) if (existsSync(path)) found.add(path);
  }
  return [...found];
}

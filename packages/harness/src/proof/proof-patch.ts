/**
 * Whether a proof's patch stays inside the lines a finding cites; building and applying it. Pure: text only.
 *
 * A proof shows that the cited lines cause the failure: the test fails, and passes once only those lines
 * change. A patch that edits anything else could make the test pass for another reason, so it proves nothing
 * about the cited lines.
 */

/** A finding's location: one file, lines `start` to `end` (1-based, inclusive) of the reviewed commit. */
export interface Cited {
  file: string;
  start: number;
  end: number;
}

interface Hunk {
  /** The old file's line the hunk starts at, as its header says ("-N,0" inserts after line N). */
  oldStart: number;
  oldLen: number;
  /** Its body lines, each with its prefix: " ", "-" or "+". */
  body: string[];
}

/**
 * A unified diff split into the lines outside hunks (file headers and the like) and its hunks. A hunk's body is
 * read by the line counts in its header, so a content line such as `+++ x` inside a hunk is never taken for a
 * file header. Null when a hunk ends before its counts are met.
 */
function parsePatch(patch: string): { outside: string[]; hunks: Hunk[] } | null {
  const outside: string[] = [];
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      const kind = line[0];
      if (kind === " " || kind === "-") oldLeft -= 1;
      if (kind === " " || kind === "+") newLeft -= 1;
      if (!(kind === " " || kind === "-" || kind === "+") || oldLeft < 0 || newLeft < 0) return null;
      hunk.body.push(line);
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (header) {
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLeft = header[3] === undefined ? 1 : Number(header[3]);
      hunk = { oldStart: Number(header[1]), oldLen: oldLeft, body: [] };
      hunks.push(hunk);
    } else if (!line.startsWith("\\") && line !== "") {
      outside.push(line);
    }
  }
  return oldLeft > 0 || newLeft > 0 ? null : { outside, hunks };
}

/**
 * Why `patch` reaches outside `cited`, or null when it stays inside. Inside means: one file, the cited one,
 * modified in place (not created, deleted or renamed); every removed line is a cited line; every added line
 * sits right after a cited line or right before the first one.
 */
export function patchProblem(patch: string, cited: Cited): string | null {
  const parsed = parsePatch(patch);
  if (!parsed) return "the patch is cut short: a hunk has fewer lines than its header says";
  const files = parsed.outside.filter((l) => l.startsWith("+++ ") || l.startsWith("--- "));
  if (files.length === 0) return "the patch changes no file";
  const names = new Set(
    files.map((l) =>
      l
        .slice(4)
        .replace(/^[ab]\//, "")
        .trim(),
    ),
  );
  if (names.has("/dev/null")) return "the patch creates or deletes a file";
  if (names.size !== 1 || !names.has(cited.file)) {
    return `the patch changes ${[...names].join(", ")}, not only ${cited.file}`;
  }
  if (parsed.outside.some((l) => /^(rename|copy|new file|deleted file) /.test(l))) {
    return "the patch renames or creates a file";
  }
  let changes = 0;
  for (const hunk of parsed.hunks) {
    let old = hunk.oldStart - (hunk.oldLen === 0 ? 0 : 1); // the last old line the walk has passed
    for (const line of hunk.body) {
      if (line.startsWith(" ")) old += 1;
      else if (line.startsWith("-")) {
        old += 1;
        changes += 1;
        if (old < cited.start || old > cited.end)
          return `the patch removes line ${old}, outside ${cited.start}-${cited.end}`;
      } else {
        changes += 1;
        if (old < cited.start - 1 || old > cited.end) {
          return `the patch adds a line after line ${old}, outside ${cited.start}-${cited.end}`;
        }
      }
    }
  }
  return changes === 0 ? "the patch changes no line" : null;
}

/** A fix as a bundle states it: lines `start` to `end` of the file replaced by `lines` (none to delete them). */
export interface Replacement {
  start: number;
  end: number;
  lines: string[];
}

/** The unified diff that makes `fix` to `text` (the file `file`), or null when `fix` names lines `text` lacks. */
export function replacementPatch(text: string, file: string, fix: Replacement): string | null {
  const source = text.split(/\r?\n/);
  const valid = Number.isInteger(fix.start) && Number.isInteger(fix.end) && Array.isArray(fix.lines);
  if (!valid || fix.start < 1 || fix.end < fix.start || fix.end > source.length) return null;
  const old = source.slice(fix.start - 1, fix.end);
  const newStart = fix.lines.length ? fix.start : fix.start - 1;
  return [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -${fix.start},${old.length} +${newStart},${fix.lines.length} @@`,
    ...old.map((l) => `-${l}`),
    ...fix.lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

/**
 * `text` with a one-file patch applied, or null when any hunk's context or removed lines don't match `text`
 * exactly at the hunk's position. Strict on purpose: no fuzz, no search for a nearby match. Every line keeps its
 * own line end, so lines the patch doesn't touch stay byte for byte as they were, even in a file with mixed ends.
 * An added line takes the end of the line it replaces or follows.
 */
export function applyPatch(text: string, patch: string): string | null {
  const parsed = parsePatch(patch);
  if (!parsed) return null;
  const source = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const content = (line: string) => line.replace(/\r?\n$/, "");
  const end = (line: string | undefined) => /\r?\n$/.exec(line ?? "")?.[0] ?? "\n";
  const out: string[] = [];
  let next = 0; // index into `source` of the first line not yet copied
  for (const hunk of parsed.hunks) {
    const at = hunk.oldStart - (hunk.oldLen === 0 ? 0 : 1);
    if (at < next || at > source.length) return null;
    out.push(...source.slice(next, at));
    next = at;
    let replaced: string | undefined; // the end of the line just removed, for the lines added in its place
    for (const line of hunk.body) {
      if (line.startsWith("+")) {
        out.push(`${line.slice(1)}${replaced ?? end(source[next] ?? source[next - 1])}`);
        continue;
      }
      if (content(source[next] ?? "") !== line.slice(1) || next >= source.length) return null;
      if (line.startsWith(" ")) out.push(source[next] as string);
      replaced = line.startsWith("-") ? end(source[next]) : undefined;
      next += 1;
    }
  }
  return [...out, ...source.slice(next)].join("");
}

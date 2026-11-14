/**
 * The files a command would post: message and body files behind a flag (`git commit -F`, `--body-file`,
 * `--notes-file`, `--input`, `--template`, a gh API field's `@file`), read so their text can be checked like
 * text written in the command. Split out of guard-target.ts (AUD-M3).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { postedRanges, STDIN_BODY } from "./guard-posted.ts";
import { navigationTargets } from "./guard-repos.ts";
import { blankQuoted, gitSteps, quotedMask, substitutions } from "./shell-scan.ts";

/** The most a posted file may hold: read in well under the hook's time limit (Qodo on PR 233). */
export const MAX_POSTED_BYTES = 1024 * 1024;

/** Thrown when a posted file can't be checked; the guard turns it into a deny with this message. */
export class Unreadable extends Error {}

/**
 * Every folder a relative file name in the command could be read from: the folder the hook runs in, and
 * each folder the command moves into before it. `cd ../app && gh pr create --body-file body.md` reads the
 * app's `body.md`, not the hook folder's (AUD-M3). Reading one file too many is harmless.
 */
function folders(cwd: string, command: string): string[] {
  return [...new Set([cwd, ...navigationTargets(command, cwd)])];
}

/**
 * The text of a file the command names, from every folder it could be read from. A file too large to read
 * well inside the hook's time limit is refused, never half-checked. Empty when it exists nowhere.
 */
export function readPosted(cwd: string, command: string, file: string): string[] {
  const paths = isAbsolute(file) ? [file] : folders(cwd, command).map((dir) => resolve(dir, file));
  const texts: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    if (statSync(path).size > MAX_POSTED_BYTES) {
      throw new Unreadable(
        `This command would post ${file}, which is over ${MAX_POSTED_BYTES} bytes, more than the guard reads. Post less.`,
      );
    }
    texts.push(readFileSync(path, "utf8"));
  }
  return texts;
}

/**
 * Contents of message or body files the command reads, e.g. `git commit -F msg.txt` or `--body-file`.
 * Every file that exists behind such a flag is read, however the flag is quoted: a file the command would
 * really post exists when the hook runs, and reading one more file is harmless. A `gh api` field
 * (`-F name=value`) is text unless its value is `@file`, which gh reads from that file; a file really
 * named `name=value` is read too, because `git commit -F` would read it. `--template` (gh) and a commit's
 * `-t`/`--template` are posted files too (AUD-N9). A flag whose file doesn't exist is words in a message
 * when it sits in quoted text or a heredoc body, and otherwise a failure: the guard can't check what would
 * be posted, so nothing is posted. A file that exists but can't be read throws, and the hook fails closed.
 */
export function referencedFiles(cwd: string, command: string): string[] {
  const files: string[] = [];
  const quoted = quotedMask(command);
  const ghApi = /\bgh\s+api\b/.test(command);
  // A template is a posted file only to a command that posts one: elsewhere `--template` means something else.
  const commits = gitSteps(command, /\bcommit\b/);
  const template = commits.length || /\bgh\s+(?:pr|issue)\s+create\b/.test(command) ? "|--template" : "";
  // A bare file name ends at whitespace, a quote or a shell separator: `-F msg.txt; echo` names msg.txt.
  const value = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s"';&|<>()]+))`;
  const flags = new RegExp(
    // `--field` is `-F`'s long form, whose `name=@file` gh reads (Qodo on PR 266).
    String.raw`(\s-F|--field|--file|--body-file|--notes-file|--input${template})(?:[\s=]+|(?<=-F)(?=[^\s=-]))${value}`,
    "dg",
  );
  // `-t` is a commit's template only inside a commit step; to gh it is a title.
  // Each commit step is searched on its own, so the cost stays linear (AUD-M4).
  const commitT = new RegExp(String.raw`\s(-t)[\s=]+${value}`, "dg");
  const at = (offset: number) => (m: RegExpMatchArray) => {
    const flag = m[1] ?? "";
    // The flag's own position: for ` -F` that is after the leading space.
    const flagAt = offset + (m.indices?.[1]?.[0] ?? m.index ?? 0) + flag.length - flag.trimStart().length;
    return { named: m[2] ?? m[3] ?? m[4], flagAt };
  };
  const found = [
    ...[...command.matchAll(flags)].map(at(0)),
    ...commits.flatMap((step) => [...step.text.matchAll(commitT)].map(at(step.start))),
  ];
  for (const { named, flagAt } of found) {
    let file = named;
    if (!file || file === "-") continue;
    const field = ghApi ? /^[\w.[\]-]+=(.*)$/s.exec(file) : null;
    if (field && !readPosted(cwd, command, file).length) {
      if (!field[1]?.startsWith("@")) continue;
      file = field[1].slice(1);
      if (!file || file === "-") continue;
    }
    const texts = readPosted(cwd, command, file);
    if (texts.length) {
      files.push(...texts);
      continue;
    }
    if (quoted[flagAt]) continue;
    throw new Unreadable(
      `This command would post the contents of ${file}, which doesn't exist, so the guard can't check it. Write the file first, then run the command.`,
    );
  }
  return files;
}

/**
 * The files whose text reaches a post through stdin (AUD-M3): an input redirect (`< body.md`) and a file
 * piped in by `cat`, `type`, `Get-Content` or `gc`, when a flag reads the body from stdin. Read from every
 * folder the command could read them from; one that exists nowhere can't be checked, so it throws.
 */
export function stdinFiles(cwd: string, command: string): string[] {
  if (!STDIN_BODY.test(command)) return [];
  const value = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s"';&|<>()]+))`;
  // An input redirect names one file; a reader names every file it is given, all posted (Qodo on PR 265).
  const redirect = new RegExp(String.raw`(?<![<\d])<(?!<)\s*${value}`, "g");
  const reader = /\b(?:cat|type|Get-Content|gc)\s+([^|;&\n<>()]*)/gi;
  const quoted = quotedMask(command);
  const named: string[] = [];
  for (const m of command.matchAll(redirect)) if (!quoted[m.index]) named.push(m[1] ?? m[2] ?? m[3] ?? "");
  for (const m of command.matchAll(reader)) {
    if (quoted[m.index]) continue;
    // A descriptor number before a redirect (`2>/dev/null`) is not a file (Qodo on PR 266).
    const args = (m[1] ?? "").replace(/\s\d+\s*$/, "");
    const words = [...args.matchAll(new RegExp(value, "g"))].map((w) => w[1] ?? w[2] ?? w[3] ?? "");
    for (let i = 0; i < words.length; i++) {
      if (/^-Encoding$/i.test(words[i] ?? "")) i++;
      else named.push(words[i] ?? "");
    }
  }
  const texts: string[] = [];
  for (const file of named) {
    if (!file || file.startsWith("-") || /^\d*>/.test(file)) continue;
    const read = /[$`%]/.test(file) ? [] : readPosted(cwd, command, file);
    if (!read.length) {
      throw new Unreadable(
        `This command would post the contents of ${file} through stdin, and the guard can't read that file. Write the body to a file and pass it with --body-file.`,
      );
    }
    texts.push(...read);
  }
  return texts;
}

/** Text built by a command the guard can't read: refused in a post to a reviewed repo (#242). */
export class BuiltText extends Error {}

/** The file a substitution reads, when all it does is read one: `cat f`, `type f`, `Get-Content f`, `gc f`, `< f`. */
function fileRead(inner: string): string | undefined {
  const value = String.raw`(?:"([^"]+)"|'([^']+)'|([^\s"';&|<>()]+))`;
  const m = new RegExp(
    String.raw`^\s*(?:<\s*|(?:cat|type|Get-Content|gc)\s+(?:-(?:Raw|Path|LiteralPath|Encoding\s+\S+)\s+)*)${value}\s*$`,
    "i",
  ).exec(inner);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/**
 * The text a post builds from commands (#242): each substitution inside a posted value, or anywhere when the
 * body comes from stdin, that only reads a file is read and returned, so the file's text is checked like
 * the command's own. With `strict` (a post to a reviewed repo), any other substitution, and a body piped in
 * from anything but `cat`, `type`, `Get-Content`, `echo` or `printf`, throws `BuiltText`: what a program
 * prints can't be checked before it runs. A file that can't be read throws `Unreadable`. With `everywhere`
 * false (a lab post, read strictly while private templates exist: #285), only substitutions in posted values
 * and a body from stdin are held to that.
 */
export function builtText(
  cwd: string,
  command: string,
  strict: boolean,
  backticks: boolean,
  everywhere = strict,
): string[] {
  const stdin = STDIN_BODY.test(command);
  const ranges = postedRanges(command);
  // In a post to a reviewed repo every substitution counts, wherever it sits: a label's name or a homepage is
  // posted text too (Qodo on PR 266). Elsewhere only those in posted values are read.
  const posted = (at: number) => everywhere || stdin || ranges.some(([start, end]) => at >= start && at < end);
  const texts: string[] = [];
  // A substitution inside another posts its output too, so each nested one is looked at (Qodo on PR 266).
  const nested = (outer: { start: number; inner: string }[]): { start: number; inner: string }[] =>
    outer.flatMap((sub) => [
      sub,
      ...nested(substitutions(sub.inner, backticks)).map((s) => ({ ...s, start: sub.start })),
    ]);
  for (const sub of nested(substitutions(command, backticks))) {
    if (!posted(sub.start)) continue;
    if (!strict && fileRead(sub.inner) === undefined) continue;
    const file = fileRead(sub.inner);
    if (file === undefined) {
      if (strict) {
        throw new BuiltText(
          `This post builds its text by running "${sub.inner.trim().slice(0, 40)}", which the guard can't check before it runs. Write the text to a file and pass it with --body-file.`,
        );
      }
      continue;
    }
    const read = /[$`%]/.test(file) ? [] : readPosted(cwd, command, file);
    if (!read.length) {
      throw new Unreadable(
        `This post reads ${file}, and the guard can't read that file, so it can't check the text. Write the file first, then post it with --body-file.`,
      );
    }
    texts.push(...read);
  }
  // A process substitution runs a program as a file, and a PowerShell `(…)` or `@(…)` argument runs one too.
  const blank = blankQuoted(command);
  if (everywhere && (/[<>]\(/.test(blank) || (!backticks && /(?:^|\s)@?\(/.test(blank)))) {
    throw new BuiltText(
      "This post's text may come from a program the guard can't check before it runs. Write the text to a file and pass it with --body-file.",
    );
  }
  if (strict && stdin) {
    const producer = pipedInto(command);
    // A reader must name its files: a bare `cat` passes on whatever is piped into it (Qodo on PR 266).
    const reads = /^(?:cat|type|Get-Content|gc)\s+\S/i.test(producer ?? "");
    // printf with a format (`%s`) or an escape, and `echo -e`, build text the guard would have to run (#285).
    // The producer is read with its quoted text blanked, so its format is looked for in the command itself.
    const plain =
      /^(?:echo|Write-Output)\b(?!\s+-\w*e)/i.test(producer ?? "") ||
      (/^printf\b/.test(producer ?? "") && !/\bprintf\b[^|]*(%|\\(x|u|[0-7]))/.test(command));
    if (producer !== undefined && !reads && !plain) {
      throw new BuiltText(
        `This post's body is piped in from "${producer.slice(0, 40)}", which the guard can't check before it runs. Write the text to a file and pass it with --body-file.`,
      );
    }
  }
  return texts;
}

/** The step whose output is piped into the step that reads its body from stdin, or undefined when none is. */
function pipedInto(command: string): string | undefined {
  const blank = blankQuoted(command);
  const at = blank.search(STDIN_BODY);
  if (at < 0) return undefined;
  const before = blank.slice(0, at);
  const stepStart = Math.max(
    before.lastIndexOf(";"),
    before.lastIndexOf("&"),
    before.lastIndexOf("\n"),
    before.lastIndexOf("|"),
  );
  if (stepStart < 0 || before[stepStart] !== "|" || before[stepStart - 1] === "|") return undefined;
  const producerStart = Math.max(
    before.lastIndexOf(";", stepStart - 1),
    before.lastIndexOf("&", stepStart - 1),
    before.lastIndexOf("\n", stepStart - 1),
    before.lastIndexOf("|", stepStart - 1),
  );
  return before.slice(producerStart + 1, stepStart).trim();
}

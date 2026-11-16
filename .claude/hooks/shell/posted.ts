/**
 * What text a shell command would post, as the shell would post it: flag values, heredoc bodies, and the
 * parts git joins into one commit message. The guard decides what to do with the text; this module only
 * finds it.
 */
import { gitSteps, heredocBodies } from "./scan.ts";

/**
 * The text a command would post, as written: flag values and heredoc bodies, or the whole command when
 * the text is piped in or built from shell variables. Nothing in it identifies a repo to the shell, so no
 * name is stripped from it: a lab link or `owner/name` in a message is a hint like any other.
 */
export function postedText(command: string): string[] {
  // Flags are read outside heredoc bodies: an option-looking line in one is text, not an argument.
  const spans = heredocBodies(command);
  let outside = command;
  for (const span of [...spans].reverse()) outside = outside.slice(0, span.start) + outside.slice(span.end);
  const posted = postedArguments(outside);
  const heredocs = spans.map((span) => command.slice(span.start, span.end));
  const stdin = STDIN_BODY.test(command);
  // With no body from stdin and nothing built by the shell, the flag values are all that is posted. Any
  // heredoc then belongs to another command, and the whole-command check already reads it.
  if (!stdin && !posted.some((p) => /[$`]/.test(p))) return posted;
  // Otherwise the posted text can be anywhere: piped from an earlier step, in a heredoc, or built by a
  // substitution. So the whole command is judged with only the paths it reads from or moves into blanked,
  // beside the flag values and heredoc bodies. Everything from the first `<<` on is also judged as written,
  // however its delimiter is quoted or however many heredocs share the line. A clean post can be refused
  // for text a neighbouring step holds; refusing a clean post is the safe mistake.
  const fromFirstHeredoc = command.includes("<<") ? [command.slice(command.indexOf("<<"))] : [];
  return [
    blankLocalPaths(command, true),
    ...posted.map((value) => blankLocalPaths(value, false)),
    ...heredocs,
    ...fromFirstHeredoc,
  ];
}

/** A flag that reads its body from stdin (`-`, or `-F-`), followed by a blank, a shell operator or the end. */
export const STDIN_BODY =
  /(\s-F|--file|--body-file|--notes-file|--input)(?:[\s=]+|(?<=-F))-(?=[\s;&|)]|$)|(?:\s-F|--field)[\s=]*["']?[\w.[\]-]+=@-(?=[\s"';&|)]|$)/;

/**
 * The text with the files a body is read from blanked: the path after `cat`, `type` or `Get-Content`
 * (`gc`), and in a whole command after an input redirect `<`. Only those: path-shaped text anywhere else
 * may be the message itself, and inside a quoted value a `<` is just text.
 */
function blankLocalPaths(text: string, redirects: boolean): string {
  // In a whole command, the folders it moves into are paths too: `cd`, `pushd`, `Set-Location`, `git -C`,
  // `--git-dir` and `--work-tree` name where it runs, never what it posts.
  const navigates =
    /\b(?:cd|pushd|Set-Location|sl)\s+(?:-(?:Literal)?Path\s+)?|\bgit\s+-C\s*|--(?:git-dir|work-tree)[=\s]\s*/;
  // A reader's own options (`Get-Content -Raw`) come before its file; `$(< file)` reads one too.
  const readers = /\b(?:cat|type|Get-Content|gc)\s+(?:-(?:Raw|Path|LiteralPath|Encoding\s+\S+)\s+)*|\$\(\s*<\s*/;
  const reader = redirects ? new RegExp(`${readers.source}|<\\s*|${navigates.source}`) : readers;
  return text.replace(new RegExp(`(${reader.source})(["']?)[^\\s"'\`;&|<>()]+\\2`, "gi"), "$1 ");
}

export function commitSteps(command: string): string[] {
  return gitSteps(command, /\bcommit\b/).map((step) => step.text);
}

/**
 * Every message value in one `git commit` step, `-m`, `--message`, or `m` at the end of combined short
 * flags such as `-am`, and every `--trailer`: git joins them into one message. A message file
 * (`-F`, `--file`) or a template (`-t`, `--template`) is read by `referencedFiles`.
 */
export function commitMessages(step: string): string[] {
  const pattern =
    /(?:^|\s)(?:-[A-Za-z]*m|--message|--trailer)(?=[\s="']|$)[\s=]*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g;
  return [...step.matchAll(pattern)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

/**
 * The text a command would post: commit messages, titles, bodies and API fields. Other parts of
 * the command, such as a script that edits a file, are left out.
 */
export function postedArguments(command: string): string[] {
  return [...command.matchAll(postedFlagValue())].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

/**
 * A flag that posts text, with its value. `--subject` is a merge commit's title, `--notes` a release's,
 * `--description` a label's, `--trailer` a line git adds to a commit message. Their short forms (`-n`, `-d`)
 * mean other things to git, so only the long ones are read here; the whole-command check still reads the rest.
 */
function postedFlagValue(): RegExp {
  const flag =
    /(?:^|\s)(?:-m|--message|-t|--title|-b|--body|--subject|--notes|--description|--trailer|(?:-f|-F|--field|--raw-field)[\s=]*[\w.[\]-]+=)[\s=]*/;
  const value = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/;
  return new RegExp(`${flag.source}(?:${value.source})`, "g");
}

/**
 * The command with its posted text taken out: flag values and heredoc bodies. What is left is what the shell
 * acts on, so a destination is read from there: `--repo` or `-R` written inside a message names no repo.
 */
export function outsidePostedText(command: string): string {
  let outside = command;
  for (const span of [...heredocBodies(command)].reverse()) {
    outside = outside.slice(0, span.start) + outside.slice(span.end);
  }
  return outside.replace(postedFlagValue(), " ");
}

/**
 * The command with only its posted flag values taken out. Heredoc bodies stay: a shell can run one
 * (`bash <<'EOF'`), so a move or an unreadable repo in it still counts.
 */
export function withoutPostedValues(command: string): string {
  return command.replace(postedFlagValue(), " ");
}

/** Where each posted flag value sits in the command, quotes included: `[start, end)`. */
export function postedRanges(command: string): [number, number][] {
  const pattern = new RegExp(postedFlagValue().source, "dg");
  return [...command.matchAll(pattern)].flatMap((m) => {
    const value = m.indices?.[1] ?? m.indices?.[2] ?? m.indices?.[3];
    if (!value) return [];
    // The quote before a quoted value belongs to it, and so does whatever the shell joins on after its closing
    // quote, up to the next blank or operator: `--body="a"$(cat f)` posts f too.
    let end = value[1] + 1;
    while (end < command.length && !/[\s;&|]/.test(command[end] ?? "")) end++;
    return [[Math.max(0, value[0] - (m[3] === undefined ? 1 : 0)), end] as [number, number]];
  });
}

/** Every string in a tool input, keys and values, however deeply nested. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [k, ...stringsIn(v)]);
  return value === undefined || value === null ? [] : [String(value)];
}

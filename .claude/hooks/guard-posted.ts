/**
 * What text a shell command would post, as the shell would post it: flag values, heredoc bodies, and the
 * parts git joins into one commit message. Split out of guard-target.ts along this seam (#199); the guard
 * decides what to do with the text, this module only finds it.
 */

/**
 * The text a command would post, as written: flag values and heredoc bodies, or the whole command when
 * the text is piped in or built from shell variables. Nothing in it identifies a repo to the shell, so no
 * name is stripped from it: a lab link or `owner/name` in a message is a hint like any other.
 */
export function postedText(command: string): string[] {
  // Flags are read outside heredoc bodies: an option-looking line in one is text, not an argument.
  const spans = heredocSpans(command);
  let outside = command;
  for (const span of [...spans].reverse()) outside = outside.slice(0, span.start) + outside.slice(span.end);
  const posted = postedArguments(outside);
  const heredocs = spans.map((span) => command.slice(span.start, span.end));
  const stdin = STDIN_BODY.test(command);
  // With no body from stdin and nothing built by the shell, the flag values are all that is posted. Any
  // heredoc then belongs to another command, and the whole-command check already reads it as before.
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

/** A flag that reads its body from stdin (`-`), followed by a blank, a shell operator or the end. */
export const STDIN_BODY = /(\s-F|--file|--body-file|--input)[\s=]+-(?=[\s;&|)]|$)/;

/**
 * Where each heredoc body sits in the command, as the shell reads it. The delimiter is the word after
 * `<<` (or `<<-`) with its quoting removed: quote marks and backslashes quote, so `'EOF'`, `\EOF` and
 * `E\OF` all mean `EOF`, and `EOF-` is not `EOF`. The body starts on the next line and ends before the
 * first line that is the delimiter alone; `<<-` lets tabs, never spaces, come before it. A body with no
 * such line runs to the end of the command.
 */
function heredocSpans(command: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const opener = /<<(-?)[ \t]*((?:\\.|[^\s<>|;&()])+)/g;
  let match: RegExpExecArray | null = opener.exec(command);
  while (match) {
    const tabs = match[1] === "-";
    const delimiter = (match[2] ?? "").replace(/\\(.)/g, "$1").replace(/["']/g, "");
    const lineEnd = command.indexOf("\n", match.index);
    if (lineEnd < 0 || !delimiter) break;
    const start = lineEnd + 1;
    let at = start;
    let end = command.length;
    while (at <= command.length) {
      const next = command.indexOf("\n", at);
      const line = command.slice(at, next < 0 ? command.length : next);
      if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) {
        end = at;
        break;
      }
      if (next < 0) break;
      at = next + 1;
    }
    spans.push({ start, end });
    opener.lastIndex = end;
    match = opener.exec(command);
  }
  return spans;
}

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
  const reader = redirects
    ? new RegExp(`\\b(?:cat|type|Get-Content|gc)\\s+|<\\s*|${navigates.source}`)
    : /\b(?:cat|type|Get-Content|gc)\s+/;
  return text.replace(new RegExp(`(${reader.source})(["']?)[^\\s"'\`;&|<>()]+\\2`, "gi"), "$1 ");
}

/** Every part of a chained command that runs `git commit`, each up to the next shell operator. */
export function commitSteps(command: string): string[] {
  return [...command.matchAll(/\bgit\b[^|;&\n]*\bcommit\b[^|;&\n]*/g)].map((m) => m[0]);
}

/**
 * Every message value in one `git commit` step, `-m`, `--message`, or `m` at the end of combined short
 * flags such as `-am`: git joins them into one message.
 */
export function commitMessages(step: string): string[] {
  const pattern = /(?:^|\s)(?:-[A-Za-z]*m|--message)(?=[\s="']|$)[\s=]*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g;
  return [...step.matchAll(pattern)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

/**
 * The text a command would post: commit messages, titles, bodies and API fields. Other parts of
 * the command, such as a script that edits a file, are left out.
 */
export function postedArguments(command: string): string[] {
  const flag = /(?:^|\s)(?:-m|--message|-t|--title|-b|--body|(?:-f|-F|--field|--raw-field)\s+\w+=)[\s=]*/;
  const value = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/;
  const pattern = new RegExp(`${flag.source}(?:${value.source})`, "g");
  return [...command.matchAll(pattern)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

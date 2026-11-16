/**
 * Where a command reaches and what kind of write it is: the GitHub repos it names as destinations, whether it
 * writes at all, whether it sends to a remote, and whether it switches git's own guard off. Every test here reads the command with its quote marks removed (`joinedWords`), so `"--force"`,
 * `gi''t` and `'+main'` read as the shell runs them.
 */
import { githubRepos } from "../shared/repos.ts";
import { blankQuoted, gitSteps, joinedWords, segments, wordThen } from "../shell/scan.ts";

const REPO = String.raw`([\w.-]+\/[\w.-]+?)(?:\.git)?(?=[/"'\s?#)]|$)`;

/**
 * Every GitHub repo (owner/name, lower case) a command names as a destination: `--repo`, `-R`, `GH_REPO=`,
 * an API route, or a URL given to `gh` or to `git push/pull/fetch/clone/remote`, anywhere in the command,
 * chained parts and quoted text included. The guard applies the strictest rule over all of them.
 */
export function explicitDestinations(command: string): string[] {
  const patterns = [
    /--repo[\s=]+["']?([\w.-]+\/[\w.-]+)/gi,
    // gh's short form, `-R`, only in capitals (`-r` is another flag, such as grep's) and with or without a
    // space before its value: `-RAJBeumer/x` works too.
    /(?<=\s)-R[\s=]*["']?([\w.-]+\/[\w.-]+)/g,
    // gh reads the repo from the environment too, in bash or PowerShell.
    /\bGH_REPO\s*=\s*["']?([\w.-]+\/[\w.-]+)/gi,
    // gh repo edit and its siblings take the repo as a plain argument.
    /\bgh\s+repo\s+[\w-]+\s+["']?([\w.-]+\/[\w.-]+)/gi,
    // An API route, with or without a path after the repo: `repos/o/n -X PATCH` edits the repo itself.
    new RegExp(String.raw`\brepos\/${REPO}`, "gi"),
  ];
  const named = patterns.flatMap((pattern) => [...command.matchAll(pattern)].map((m) => (m[1] ?? "").toLowerCase()));
  // `gh repo <verb>` takes its repo as a plain argument anywhere among its flags, in any quoting.
  const repoArgs = segments(joinedWords(command)).flatMap((part) =>
    /\bgh\s+repo\s/.test(part.text)
      ? part.text
          .split(/\s+/)
          .filter((word) => /^[\w.-]+\/[\w.-]+$/.test(word))
          .map((word) => word.toLowerCase())
      : [],
  );
  named.push(...repoArgs);
  // An issue or PR URL as gh's first argument, in any spelling of GitHub's host.
  for (const m of command.matchAll(/\bgh\s+(?:pr|issue)\s+\w+\s+["']?(\S+)/gi)) named.push(...githubRepos(m[1] ?? ""));
  // A URL given to git, in any spelling (`ssh://git@ssh.github.com:443/o/n`), one git step at a time so the
  // cost stays linear.
  const urls = gitSteps(command, /\b(?:push|pull|fetch|clone|remote|send-pack)\b/).flatMap((step) =>
    githubRepos(step.text),
  );
  // gh takes `owner/name.git` for `owner/name`.
  return [...named, ...urls].map((repo) => repo.replace(/\.git$/, ""));
}

/**
 * Repos named by a GitHub URL anywhere in `outside`, the command with its posted text taken out: an issue URL
 * after the flags (`gh issue comment --body … https://github.com/o/n/issues/3`) is where the post goes.
 * Read only outside posted text, because a link inside a message is words, judged by the link rule.
 */
export function urlDestinations(outside: string): string[] {
  // Only in a gh step: a URL another program is given (a script's argument, say) is not where gh posts.
  return segments(joinedWords(outside)).flatMap((part) => {
    const gh = /\bgh\s/.exec(part.text);
    return gh ? githubRepos(part.text.slice(gh.index)) : [];
  });
}

/**
 * True when the command runs a GraphQL mutation, which can write to any repo: through `gh api graphql`, or as a
 * raw write to GitHub's GraphQL endpoint, whose payload may sit in a file the guard doesn't read.
 */
export function graphqlMutation(command: string): boolean {
  // A query read from a file (`--input f`, `-F query=@f`) may be a mutation the command text doesn't show,
  // in any spelling: `--field query=@f`, a quoted `-F "query=@f"`.
  const fromFile = /--input\b|=@/.test(joinedWords(command));
  if (/\bgh\s+api\s+graphql\b/i.test(command) && (fromFile || /\bmutation\b/i.test(command))) return true;
  return rawApiWrite(command) && /api\.github\.com\/graphql\b/i.test(joinedWords(command));
}

/** The HTTP clients the guard reads: curl, wget, PowerShell's web calls, httpie and xh. */
export const HTTP_CLIENT =
  /(?:^|[\s/\\])(curl|wget|Invoke-RestMethod|Invoke-WebRequest|irm|iwr|https?|xh)(?:\.exe)?(?=\s|$)/i;

/**
 * True when an HTTP client's arguments send something: a body, a form, an upload, or a method other than GET or
 * HEAD. curl's short options are read alone or combined (`-d`, `-sd`, `-sX POST`, `-XPOST`) and in their own
 * case, so `-f`, `-D` and `-x` stay reads; a PowerShell parameter (`-Headers`) is a word, not a cluster. A long option
 * or a PowerShell parameter counts by any start of its name, as wget and PowerShell take one (`--post-d`, `-Me`,
 * `-Bo`), and a bare method word (`POST`) counts anywhere. httpie and xh send a body for a data item (`key=value`,
 * `key:=json`, `field@file`, `@file`) or a method word.
 */
export function httpSends(client: string, args: string[]): boolean {
  const method = (value: string) => !/^(GET|HEAD)$/i.test(value);
  const shell = /^(irm|iwr|Invoke-RestMethod|Invoke-WebRequest)$/i.test(client);
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (/^(POST|PUT|PATCH|DELETE)$/i.test(a)) return true;
    // A long option, or a PowerShell parameter, by any unambiguous start of a name that sends.
    const long = shell ? /^-([A-Za-z]{2,})(?::(.*))?$/.exec(a) : /^--([a-z][\w-]{2,})(?:=(.*))?$/.exec(a);
    if (long) {
      const name = (long[1] ?? "").toLowerCase();
      const sends = (shell ? PS_SENDS : LONG_SENDS).filter((full) => full.startsWith(name));
      if (sends.some((full) => !/^(method|request|custommethod)$/.test(full))) return true;
      if (sends.length && method(long[2] ?? args[i + 1] ?? "")) return true;
      continue;
    }
    const short = /^-([a-zA-Z]+)(.*)$/.exec(a);
    if (/^curl/i.test(client) && short && !/^[A-Z][a-z]{2,}/.test(short[1] ?? "")) {
      const letters = short[1] ?? "";
      const x = letters.indexOf("X");
      const data = letters.search(/[dFT]/);
      if (data >= 0 && (x < 0 || data < x)) return true;
      if (x >= 0 && method(`${letters.slice(x + 1)}${short[2] ?? ""}` || (args[i + 1] ?? ""))) return true;
    }
  }
  if (!/^(https?|xh)$/i.test(client)) return false;
  const items = args.filter((a) => !a.startsWith("-"));
  return (
    args.some((a) => /^(--form|-f|--raw|--multipart)$/.test(a)) ||
    /^(POST|PUT|PATCH|DELETE)$/i.test(items[0] ?? "") ||
    items.some((a) => !/:\/\//.test(a) && /^(?:@|[^=:@\s]+(?:==?|:=|:=@|=@|@))/.test(a))
  );
}

/** The long options of curl, wget and httpie that send a body or choose a method. */
const LONG_SENDS = [
  "data",
  "data-ascii",
  "data-binary",
  "data-raw",
  "data-urlencode",
  "json",
  "form",
  "form-string",
  "upload-file",
  "post-data",
  "post-file",
  "body-data",
  "body-file",
  "method",
  "request",
];
/** PowerShell's web-call parameters that send a body or choose a method, in lower case. */
const PS_SENDS = ["method", "custommethod", "body", "infile", "form"];

/** True when the command sends a write to GitHub with something other than `gh`: curl, wget, PowerShell's web calls. */
function rawApiWrite(command: string): boolean {
  return segments(joinedWords(command)).some(({ text }) => {
    const client = HTTP_CLIENT.exec(text);
    if (!client) return false;
    const after = text.slice(client.index + client[0].length);
    return /github\.com/i.test(after) && httpSends(client[1] ?? "", after.trim().split(/\s+/));
  });
}

/**
 * True when the command writes to a repo: a commit, push, tag or note; a gh command that posts or changes
 * a PR, issue, label, release, workflow run or the repo itself; a gh API call with a method, a field or an
 * input; or a raw API write.
 */
export function isWrite(command: string): boolean {
  // A backslash before a letter is no character to the shell either: `g\h` runs gh.
  const unescaped = command.replace(/\\(?=[\w-])/g, "");
  return writes(joinedWords(command), command) || (unescaped !== command && writes(joinedWords(unescaped), command));
}

/**
 * True when the command makes a gh or raw API write. With a push (target/door.ts reads git's own subcommand for
 * that), that is everything that sends to a remote; a commit, tag or note stays in the checkout until a push sends
 * it.
 */
export function isSend(command: string): boolean {
  const unescaped = command.replace(/\\(?=[\w-])/g, "");
  return sends(joinedWords(command), command) || (unescaped !== command && sends(joinedWords(unescaped), command));
}

/** True when `c`, the command with its quotes removed, writes to a repo; `command` is as written. */
function writes(c: string, command: string): boolean {
  return gitSteps(c, /\b(commit|push|tag|notes|send-pack)\b/).length > 0 || sends(c, command);
}

/** True when `c`, the command with its quotes removed, makes a gh or raw API write; `command` is as written. */
function sends(c: string, command: string): boolean {
  return (
    /\bgh\s+(pr|issue)\s+(create|edit|comment|review|close|reopen|merge|develop|lock|unlock|transfer|pin|delete)\b/.test(
      c,
    ) ||
    // Labels and releases post text to the repo too: a label's name and description, a release's notes.
    /\bgh\s+(label|release)\s+(create|edit|upload|clone)\b/.test(c) ||
    /\bgh\s+repo\s+(edit|rename|create|delete|archive|unarchive|sync|fork)\b/.test(c) ||
    /\bgh\s+(workflow\s+run|run\s+rerun|gist\s+(create|edit)|secret\s+set|variable\s+set)\b/.test(c) ||
    // A method other than GET or HEAD, a field, an input or GraphQL: `-X GET` reads.
    (/\bgh\s+api\b/.test(c) &&
      (/(\s-[fF]|--field|--raw-field|--input|\bgraphql\b)/.test(c) ||
        /(?:\s-X\s*=?\s*|--method[=\s]+)(?!(?:GET|HEAD)\b)\w/i.test(c))) ||
    rawApiWrite(command)
  );
}

/**
 * True when the command would switch off git's own guard hooks: `--no-verify` in any spelling, a
 * commit's `-n` (alone or in combined short flags, outside quoted text), or a hooks path or config set from
 * the command line or the environment.
 */
export function skipsGitGuard(command: string): boolean {
  const words = joinedWords(command);
  // Git takes any unambiguous start of a long option (`--no-ver`), and a `-c` whose key the shell builds could
  // be core.hooksPath. `--no-v…` only counts in a git step: in a post's body it is words.
  if (gitSteps(words, /--no-v\w*/).length) return true;
  // A config file the command points git at could set the hooks path: GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM,
  // and HOME or XDG_CONFIG_HOME, which move the user's config.
  const configFrom =
    /\bGIT_CONFIG(?:_[A-Z_]+)?\s*=|\b(?:HOME|XDG_CONFIG_HOME)\s*=|\$env:(?:GIT_CONFIG\w*|HOME|XDG_CONFIG_HOME)\s*=/i;
  if (/\bcore\.hookspath\b/i.test(words) || configFrom.test(words)) return true;
  if (wordThen(command, /\bgit\b/, /\s-c\s*["']?[^\s"']*[$%`]/)) return true;
  // A quoted option is still an option: `"-n"` reaches git as -n.
  const flags = command.replace(/(["'])(-[A-Za-z-]+)\1/g, "$2");
  return gitSteps(blankQuoted(flags), /\bcommit\b/).some((step) =>
    /\s-[a-zA-Z]*n[a-zA-Z]*\b/.test(step.text.slice(step.text.search(/\bcommit\b/))),
  );
}

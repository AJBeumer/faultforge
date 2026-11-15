/**
 * Where a command reaches and what kind of write it is: the GitHub repos it names as destinations, whether it
 * posts or pushes at all, and whether a push rewrites or deletes history. Split out of guard-target.ts
 * (AUD-M3). Every test here reads the command with its quote marks removed (`joinedWords`), so `"--force"`,
 * `gi''t` and `'+main'` read as the shell runs them.
 */
import { githubRepos } from "./guard-repos.ts";
import { blankQuoted, gitSteps, joinedWords, segments, wordThen } from "./shell-scan.ts";

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
    // space before its value: `-RAJBeumer/x` works too (Qodo on PR 208).
    /(?<=\s)-R[\s=]*["']?([\w.-]+\/[\w.-]+)/g,
    // gh reads the repo from the environment too, in bash or PowerShell (AUD-M3).
    /\bGH_REPO\s*=\s*["']?([\w.-]+\/[\w.-]+)/gi,
    // gh repo edit and its siblings take the repo as a plain argument (#242).
    /\bgh\s+repo\s+[\w-]+\s+["']?([\w.-]+\/[\w.-]+)/gi,
    // An API route, with or without a path after the repo: `repos/o/n -X PATCH` edits the repo itself.
    new RegExp(String.raw`\brepos\/${REPO}`, "gi"),
  ];
  const named = patterns.flatMap((pattern) => [...command.matchAll(pattern)].map((m) => (m[1] ?? "").toLowerCase()));
  // `gh repo <verb>` takes its repo as a plain argument anywhere among its flags, in any quoting (Qodo on PR 266).
  const repoArgs = segments(joinedWords(command)).flatMap((part) =>
    /\bgh\s+repo\s/.test(part.text)
      ? part.text
          .split(/\s+/)
          .filter((word) => /^[\w.-]+\/[\w.-]+$/.test(word))
          .map((word) => word.toLowerCase())
      : [],
  );
  named.push(...repoArgs);
  // An issue or PR URL as gh's first argument, in any spelling of GitHub's host (re-grade 4).
  for (const m of command.matchAll(/\bgh\s+(?:pr|issue)\s+\w+\s+["']?(\S+)/gi)) named.push(...githubRepos(m[1] ?? ""));
  // A URL given to git, in any spelling (`ssh://git@ssh.github.com:443/o/n`; re-grade 4), one git step at a
  // time so the cost stays linear (AUD-M4).
  const urls = gitSteps(command, /\b(?:push|pull|fetch|clone|remote|send-pack)\b/).flatMap((step) =>
    githubRepos(step.text),
  );
  // gh takes `owner/name.git` for `owner/name` (#285).
  return [...named, ...urls].map((repo) => repo.replace(/\.git$/, ""));
}

/**
 * Repos named by a GitHub URL anywhere in `outside`, the command with its posted text taken out: an issue URL
 * after the flags (`gh issue comment --body … https://github.com/o/n/issues/3`) is where the post goes (AUD-M3).
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
 * raw write to GitHub's GraphQL endpoint, whose payload may sit in a file the guard doesn't read (Qodo on PR 265).
 */
export function graphqlMutation(command: string): boolean {
  // A query read from a file (`--input f`, `-F query=@f`) may be a mutation the command text doesn't show.
  // Any spelling: `--field query=@f`, a quoted `-F "query=@f"` (Qodo on PR 266).
  const fromFile = /--input\b|=@/.test(joinedWords(command));
  if (/\bgh\s+api\s+graphql\b/i.test(command) && (fromFile || /\bmutation\b/i.test(command))) return true;
  return rawApiWrite(command) && /api\.github\.com\/graphql\b/i.test(joinedWords(command));
}

/** True when the command sends a write to GitHub with something other than `gh`: curl, wget, PowerShell's web calls. */
export function rawApiWrite(command: string): boolean {
  const words = joinedWords(command);
  return (
    wordThen(words, /\b(?:curl|wget|Invoke-RestMethod|Invoke-WebRequest|irm|iwr|http|xh)\b/i, /github\.com/i) &&
    /(?:\s-X\s*\w|--request|\s-d\b|--data|--json|--form|\s-F\b|-Method|-Body|-InFile|--post-data|--post-file|--body-file|--upload-file|\s-T\b|--method|\s(?:POST|PATCH|PUT|DELETE)\b)/i.test(
      words,
    )
  );
}

/**
 * True when the command writes to a repo: a commit, push, tag or note; a gh command that posts or changes
 * a PR, issue, label, release, workflow run or the repo itself; a gh API call with a method, a field or an
 * input; or a raw API write.
 */
export function isWrite(command: string): boolean {
  // A backslash before a letter is no character to the shell either: `g\h` runs gh (Qodo on PR 310).
  const unescaped = command.replace(/\\(?=[\w-])/g, "");
  return writes(joinedWords(command), command) || (unescaped !== command && writes(joinedWords(unescaped), command));
}

/** True when `c`, the command with its quotes removed, writes to a repo; `command` is as written. */
function writes(c: string, command: string): boolean {
  return (
    gitSteps(c, /\b(commit|push|tag|notes|send-pack)\b/).length > 0 ||
    /\bgh\s+(pr|issue)\s+(create|edit|comment|review|close|reopen|merge|develop|lock|unlock|transfer|pin|delete)\b/.test(
      c,
    ) ||
    // Labels and releases post text to the repo too: a label's name and description, a release's notes (#190).
    /\bgh\s+(label|release)\s+(create|edit|upload|clone)\b/.test(c) ||
    /\bgh\s+repo\s+(edit|rename|create|delete|archive|unarchive|sync|fork)\b/.test(c) ||
    /\bgh\s+(workflow\s+run|run\s+rerun|gist\s+(create|edit)|secret\s+set|variable\s+set)\b/.test(c) ||
    (/\bgh\s+api\b/.test(c) && /(\s-X\s*\w|--method|\s-[fF]|--field|--raw-field|--input|\bgraphql\b)/.test(c)) ||
    rawApiWrite(command)
  );
}

/**
 * True when a push in the command could rewrite or delete history: `--force` in any spelling (`-f`, `-fu`,
 * `-uf`, `--force-with-lease`, `--force-if-includes`), a `+` refspec, `--mirror`, `--delete` or `-d`, a
 * `:branch` refspec (a delete), `--prune`, or `git send-pack` (AUD-M3). With `variablesForce`, the command as
 * the shell reads it with its own variables expanded, a word a variable still builds (`$FLAG`) counts too: it
 * could be `--force`, and only a value the command sets shows it isn't (#285).
 */
export function rewritesHistory(command: string, variablesForce = false): boolean {
  const c = joinedWords(command).replace(/\\(?=\w)/g, "");
  if (gitSteps(c, /\bsend-pack\b/).length) return true;
  return gitSteps(c, /\bpush\b/).some((step) => {
    const args = step.text.slice(step.text.search(/\bpush\b/) + 4);
    if (variablesForce && /\$\{?[A-Za-z_]|\$\(/.test(args)) return true;
    return /(\s--force\b|\s--force-with-lease\b|\s--force-if-includes\b|\s-[a-zA-Z]*[fd][a-zA-Z]*\b|\s\+\S|\s--mirror\b|\s--delete\b|\s--prune\b|\s:\S)/.test(
      args,
    );
  });
}

/**
 * True when the command rewrites or deletes a ref through GitHub's API, where no git hook runs (re-grade 5): a
 * `gh api` write to `git/refs/<ref>` (an existing ref: PATCH moves it, DELETE removes it), any `git/refs` write
 * with a `force` field, a GraphQL `updateRef`, `updateRefs` or `deleteRef`, or `gh repo sync --force`. Creating
 * a new ref (`POST git/refs`) and reading refs stay allowed. `files` are the texts the command posts from files
 * (a GraphQL query read with `-F query=@q.graphql` or `--input`; Qodo on PR 329).
 */
export function rewritesRefs(command: string, files: string[] = []): boolean {
  const c = joinedWords(command).replace(/\\(?=\w)/g, "");
  const refMutation = /\b(?:updateRefs?|deleteRef)\b/;
  // A query file's comments and string values are no fields: a read that mentions a mutation in them is a read.
  const fields = files.map((text) => text.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/#[^\n]*/g, ""));
  if (/\bgh\s+api\s+graphql\b/.test(c) && [c, ...fields].some((text) => refMutation.test(text))) return true;
  return segments(c).some(({ text }) => {
    if (/\bgh\s+repo\s+sync\b/.test(text)) return /\s--force\b/.test(text);
    const gh = /\bgh\s+api\b/.exec(text);
    if (!gh) return false;
    const args = text.slice(gh.index);
    // Any owner and name, gh's `{owner}/{repo}` and `:owner/:repo` placeholders included (Qodo on PR 329).
    const route = /(?:^|\s|=)\/?repos\/[^/\s]+\/[^/\s]+\/git\/refs(\/\S*)?/.exec(args);
    if (!route) return false;
    // Every method flag, in any spelling (`-X=DELETE`, `-X GET -X DELETE`): any write among them counts.
    const methods = [...args.matchAll(/(?:\s-X\s*=?\s*|\s--method[=\s]+)(\w+)/g)].map((m) =>
      (m[1] ?? "").toUpperCase(),
    );
    const sends = /\s-[fF]|--field|--raw-field|--input/.test(args);
    const writes = methods.length ? methods.some((m) => !/^(GET|HEAD)$/.test(m)) : sends;
    if (!writes) return false;
    // `git/refs/heads/x` names an existing ref; `git/refs` alone, with or without a trailing slash, is the list.
    const existing = Boolean(route[1] && route[1] !== "/");
    return existing || /\bforce\s*=/.test(args);
  });
}

/**
 * True when the command would switch off git's own guard hooks (#242): `--no-verify` in any spelling, a
 * commit's `-n` (alone or in combined short flags, outside quoted text), or a hooks path or config set from
 * the command line or the environment.
 */
export function skipsGitGuard(command: string): boolean {
  const words = joinedWords(command);
  // Git takes any unambiguous start of a long option (`--no-ver`), and a `-c` whose key the shell builds could
  // be core.hooksPath (Qodo on PR 266).
  // `--no-v…` only counts in a git step: in a post's body it is words (Qodo on PR 266).
  if (gitSteps(words, /--no-v\w*/).length) return true;
  // A config file the command points git at could set the hooks path: GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM,
  // and HOME or XDG_CONFIG_HOME, which move the user's config (Qodo on PR 266).
  const configFrom =
    /\bGIT_CONFIG(?:_[A-Z_]+)?\s*=|\b(?:HOME|XDG_CONFIG_HOME)\s*=|\$env:(?:GIT_CONFIG\w*|HOME|XDG_CONFIG_HOME)\s*=/i;
  if (/\bcore\.hookspath\b/i.test(words) || configFrom.test(words)) return true;
  if (wordThen(command, /\bgit\b/, /\s-c\s*["']?[^\s"']*[$%`]/)) return true;
  // A quoted option is still an option: `"-n"` reaches git as -n (Qodo on PR 266).
  const flags = command.replace(/(["'])(-[A-Za-z-]+)\1/g, "$2");
  return gitSteps(blankQuoted(flags), /\bcommit\b/).some((step) =>
    /\s-[a-zA-Z]*n[a-zA-Z]*\b/.test(step.text.slice(step.text.search(/\bcommit\b/))),
  );
}

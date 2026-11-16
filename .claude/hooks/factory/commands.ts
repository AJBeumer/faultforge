/**
 * The factory policy's rules for shell commands: what an unattended run may not run, read or reach.
 * factory-policy.ts exports them again.
 */
import { codeAsWords, spokenWords } from "../shell/decode.ts";
import { inlineNetworkProblem, NETWORK_CODE, onlyLocalCalls } from "../shell/exec.ts";
import { joinedWords, MAX_COMMAND_CHARS, quotedMask, wordThen } from "../shell/scan.ts";

const CREDENTIAL_REASON = "no reading stored credentials (git credential, a credential helper)";
const PS_ENV_REASON = "no reading another process's environment (ps e, ps eww)";
const CHECK_SCRIPT_REASON =
  "the agent can't change package.json's scripts from the shell (npm pkg set, set-script): the check must stay as the ticket found it";

/** Options of git itself that take the next word as their value, read before its subcommand. */
const GIT_VALUE_OPTION = /^(-C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix)$/;
/** Options of ps that take the next word as their value, so `ps -o user` names no BSD option. */
const PS_VALUE_OPTION =
  /^(-[a-zA-Z]*[oOpqugGtCsUN]|--(sort|format|pid|ppid|user|group|tty|cols|columns|rows|lines|sid|quick-pid))$/;

/** A rule's test: a pattern, or a function for a test one pattern can't make in linear time. */
type Rule = [{ test: (text: string) => boolean }, string];

const COMMAND_RULES: Rule[] = [
  [/\bgh\s+pr\s+(merge|close|review|comment|ready)\b/i, "only the owner merges, closes or comments on a PR"],
  [/\bgh\s+issue\s+(comment|close|reopen|delete|transfer|lock)\b/i, "the runner reports on the ticket, not the agent"],
  [
    /\bgh\s+(repo|label|secret|variable|workflow|ruleset|release)\s+(?!view\b|list\b)\w/i,
    "repo settings are the owner's",
  ],
  // The board is a write the runner's audit can't see, so a run may only read it.
  [
    /\bgh\s+project\s+(?!view\b|list\b|field-list\b|item-list\b)\w/i,
    "the runner tracks the ticket; the board is the owner's",
  ],
  [/\b(schtasks|setx|crontab|launchctl|reg\s+(add|delete|import))\b/i, "no scheduled tasks or persistent settings"],
  [/\bdismiss/i, "never dismiss a finding"],
  // An alias runs later under a name no rule knows: `gh alias set c 'pr merge'`, `git config alias.p …`.
  [/\bgh\s+alias\s+(set|import)\b/i, "no gh aliases: an alias hides what a later command runs"],
  // A function, not a pattern, so a long line can't make the check slow.
  [
    { test: (text) => wordThen(text, /\bgit\b/i, /\balias\.[\w-]/i, "\n") },
    "no git aliases: an alias hides what a later command runs",
  ],
  [/\bfaultforge-private\b/i, "the private repo is the runner's: the agent never reaches it"],
  // A numeric id or a route the shell builds hides the repo's name: `repositories/${id}`.
  [/\brepositories\/(\d|\$|`)/i, "no GitHub API by repository id: name the repo, so the rules can read where it goes"],
  [
    { test: (text) => wordThen(text, /\bgh\s+api\b/i, /\$\(|`/, "\n|;&") },
    "build a gh api route in the command, not with $(…): the rules must read where it goes",
  ],
];

/**
 * The run's keys live in its environment. These rules make reading them, or sending anything out,
 * a deliberate act the hook sees. Like every text rule they are a seatbelt, not a wall: the runner's
 * after-run audit and a narrow token are the other layers.
 */
const SECRET_RULES: [RegExp, string][] = [
  [
    /\b(GH_TOKEN|GITHUB_TOKEN|QODO_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|FACTORY_GH_TOKEN)\b/,
    "the run's keys are off limits",
  ],
  [
    /(^|[\s;&|(/'"`])(env|printenv|set|export\s+-p|declare\s+-x)(\s*($|[;&|>)'"`]))/m,
    'no dumping the environment (one variable by name, such as echo "$FAULTFORGE_TICKET_FILE", is fine)',
  ],
  [/\/proc\/[^\s/]+\/environ|\bGet-ChildItem\s+env:|\$env:/i, "no reading the environment"],
  // `/proc/<pid>/envir?n` reads the runner's environment past any spelling rule.
  [/\/proc\/(\d|self\b|\$|\*|\[|\{)/i, "no reading another process's files under /proc"],
  // Any path under /proc, however it is spelled or linked: `ln -s /proc p`, `/proc/./self`.
  [/(^|[^\w.-])\/proc(\/|\b)/i, "no reading process files under /proc"],
  [/\bgh\s+auth\s+(token|status\s+(-t|--show-token))/i, "no printing the GitHub token"],
  // A credential helper prints the stored token: `git-credential-manager get`, `gh auth git-credential get`.
  // `git credential fill` itself is read as a step (stepViolations), so a message that merely says "credential" passes.
  [/\bgit-credential/i, CREDENTIAL_REASON],
  // The whole environment from a program, not only from the shell.
  [
    /(^|[\s;&|(/'"`])(env\s+-|printenv\b)/m,
    'no dumping the environment (one variable by name, such as echo "$FAULTFORGE_TICKET_FILE", is fine)',
  ],
  [
    /\bprocess\s*\.\s*env\b(?!\s*\.\s*[A-Za-z_]\w*)|\bprocess\s*\[\s*["'`]env["'`]\s*\]/,
    "no reading the whole environment (process.env); one variable by name, process.env.FAULTFORGE_TICKET_FILE, is fine",
  ],
  // Python's `environ` under any name (`os.environ`, `import os as o; o.environ`, `from os import environ`).
  [/\benviron\b/, "no reading the environment (os.environ)"],
  // Perl's `%ENV` and `$ENV{…}`, Ruby's `ENV`. `NODE_ENV` and other names that only end in ENV don't count.
  [/\bENV\b/, "no reading the environment (ENV, %ENV)"],
  // The shell's other listings: `declare -p`, `typeset -x`, `compgen -e` or `-v`.
  [
    /\b(declare|typeset)\s+-[a-zA-Z]*[xp]\b|\bcompgen\s+-[a-zA-Z]*[ve]\b/,
    'no dumping the environment (one variable by name, such as echo "$FAULTFORGE_TICKET_FILE", is fine)',
  ],
];

/** A step that runs a language's interpreter, whose code can reach the environment under any name. */
const INTERPRETER = /\b(node|nodejs|deno|bun|tsx|ts-node|python\d*(\.\d+)?|py|perl|ruby|php|irb)\b/i;

/**
 * Code that reaches a name it builds at run time, which no word rule can read: `process` used other
 * than as `process.<name>` (`globalThis.process`, `Reflect.get(process, …)`, `require("process")`), Reflect,
 * a computed member of `globalThis`, and names built from character codes, base64 or `eval`.
 */
const BUILT_NAMES: [RegExp, string][] = [
  [
    // Not a word in a file name: `scripts/process-data.mjs`.
    /(?<![\w/\\-])process\b(?![-/\\])(?!\s*\.\s*(?!env\b)[A-Za-z_$])/,
    "no reading the whole environment: in code, use process only as process.<name> (process.env.FAULTFORGE_TICKET_FILE is fine)",
  ],
  [
    /\bReflect\s*\.|\bglobalThis\s*\[|\bfromCharCode\b|\batob\s*\(|\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\b__import__\b|\bgetattr\s*\(/,
    "code that builds a name at run time can't be checked before it runs; write the name out",
  ],
];

const NETWORK_REASON = "HTTP tools and network calls may only reach the app on localhost; GitHub goes through gh";

/** Shell tools that send requests. Network calls from code (`NETWORK_CODE`) are shared with the guard. */
const HTTP_TOOLS =
  /\b(curl|wget|nc|ncat|netcat|socat|ssh|scp|sftp|telnet|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i;

/**
 * Reasons a shell command is not allowed in a factory run, or an empty list. `ticket` is the run's ticket
 * number: the agent must read the ticket from the runner's checked snapshot, never live from GitHub,
 * where someone could have added text after the check.
 */
export function commandViolations(raw: string, ticket?: string): string[] {
  // Inline code is read on its own: it may call the network under another name (`const f = fetch`), which the
  // whole command's rule doesn't count as a call.
  const reasons = inlineNetworkProblem(raw) ? [NETWORK_REASON] : [];
  for (const command of readings(raw)) {
    for (const reason of violationsIn(command, ticket)) if (!reasons.includes(reason)) reasons.push(reason);
  }
  // ps reads its option values whole (`-o pid,user`), so the shell's readings keep their punctuation. A command
  // that runs an interpreter is read as code too (punctuation as spaces: `execFileSync('ps', ['-p', '1', 'e'])` reads
  // `ps -p 1 e`), where a format list split at its commas may be refused: code fails closed.
  const shell = continued(raw).flatMap((text) => [text, spokenWords(text)]);
  const code = INTERPRETER.test(raw) ? shell.map(codeAsWords) : [];
  if ([...shell, ...code].some(psReadsEnvironment)) reasons.push(PS_ENV_REASON);
  return reasons;
}

/**
 * True when a step runs ps with a BSD-style `e`, which prints each process's environment: `ps e`, `ps eww`,
 * `ps auxe`, `ps -p 1 e`. Wherever ps stands in the step (`A=1 ps e`, `sh -c "ps e"`), so a message
 * that says "ps" with a word holding an `e` after it is refused too: it fails closed. An option that takes a value
 * (`-o`, `-eo`, `--sort`) skips that one word, so `ps -eo pid,user` passes.
 */
function psReadsEnvironment(text: string): boolean {
  return steps(text).some((step) => {
    const all = joinedWords(step).split(/\s+/).filter(Boolean);
    const at = all.findIndex((w) => (w.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "").toLowerCase() === "ps");
    if (at < 0) return false;
    for (let i = at + 1; i < all.length; i++) {
      const w = all[i] ?? "";
      if (PS_VALUE_OPTION.test(w)) i++;
      else if (/^[a-z]*e[a-z]*$/i.test(w)) return true;
    }
    return false;
  });
}

/**
 * The command's steps: its text between `|`, `;`, `&` and new lines that are not inside quotes or a heredoc
 * (a quoted separator is part of an argument, and splitting there would cut a flag off from its command).
 */
function steps(command: string): string[] {
  const quoted = quotedMask(command);
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < command.length; i++) {
    if (quoted[i] || !"|;&\n".includes(command[i] ?? "")) continue;
    if (i > start) parts.push(command.slice(start, i));
    start = i + 1;
  }
  if (start < command.length) parts.push(command.slice(start));
  return parts;
}

/**
 * The rules that look for one word and then another in the same step (`gh issue edit` then `--add-label`,
 * `git ... push` then `--force` or `main`, `gh api` then a write). One pattern over the whole command would
 * backtrack once for every first word, so a crafted command could keep the hook past its time limit. Reading
 * each step's words in order, quote marks removed as the shell removes them, stays linear.
 */
function stepViolations(command: string): string[] {
  const reasons = new Set<string>();
  const words = (text: string) => joinedWords(text).split(/\s+/).filter(Boolean);
  /** The program a word names, however it is written: `/usr/bin/git`, `\\git`, `git.exe`, `$(command -v git)`. */
  const program = (w: string) =>
    (
      w
        .replace(/^[$({`\\]+/, "")
        .replace(/[)}`;]+$/, "")
        .split(/[\\/]/)
        .pop() ?? ""
    )
      .replace(/\.exe$/i, "")
      .toLowerCase();
  for (const step of steps(command)) {
    const all = words(step);
    const at = (first: string, second: RegExp) => {
      for (let i = 0; i + 1 < all.length; i++)
        if (program(all[i] ?? "") === first && second.test(all[i + 1] ?? "")) return i + 2;
      return -1;
    };
    const edit = all.findIndex(
      (w, i) => program(w) === "gh" && /^issue$/i.test(all[i + 1] ?? "") && /^edit$/i.test(all[i + 2] ?? ""),
    );
    if (edit >= 0 && all.slice(edit).some((w) => /^--(add|remove)-label(=|$)/i.test(w)))
      reasons.add("the runner sets the ticket's labels");
    const api = at("gh", /^api$/i);
    if (api >= 0) {
      const rest = all.slice(api);
      // A field or an input is a write; so is any method but GET, written `-X POST`, `-XPOST` or `--method=POST`.
      const writes = rest.some((w, i) => {
        // `-f k=v`, `-fk=v` and `--field=k=v` alike.
        if (/^(-f|-F|--field|--raw-field|--input)(=|$)|^-[fF]\S/.test(w)) return true;
        const m = /^(?:-X|--method)=?(.*)$/.exec(w);
        if (!m) return false;
        return !/^GET$/i.test(m[1] || rest[i + 1] || "");
      });
      if (writes) reasons.add("gh api is read-only here");
    }
    const git = all.findIndex((w) => program(w) === "git");
    // git's subcommand, past its own options: `git -c x=y credential fill` and `git credential-store get`.
    let sub = git + 1;
    while (git >= 0 && /^-/.test(all[sub] ?? "")) sub += GIT_VALUE_OPTION.test(all[sub] ?? "") ? 2 : 1;
    if (git >= 0 && /^credential(-|$)/i.test(all[sub] ?? "")) reasons.add(CREDENTIAL_REASON);
    // npm's own way to change a script: `npm pkg set scripts.check=true`, `npm pkg delete scripts.test`, `npm set-script`.
    const npm = all.findIndex((w) => /^p?npm$/.test(program(w)));
    if (npm >= 0) {
      const rest = all.slice(npm + 1);
      const pkg = rest.findIndex((w, i) => /^pkg$/i.test(w) && /^(set|delete)$/i.test(rest[i + 1] ?? ""));
      if (
        rest.some((w) => /^set-script$/i.test(w)) ||
        (pkg >= 0 && rest.slice(pkg + 2).some((w) => /^scripts\b/i.test(w)))
      )
        reasons.add(CHECK_SCRIPT_REASON);
    }
    const push = git < 0 ? -1 : all.findIndex((w, i) => i > git && /^push$/i.test(w));
    if (push >= 0) {
      const after = all.slice(push + 1);
      // Short flags combine: `-fu` and `-uf` force, `-du` deletes.
      const force =
        /^(-[a-zA-Z]*[fd][a-zA-Z]*|--force|--force-with-lease|--force-if-includes|--mirror|--delete|--prune)(=|$)/;
      if (after.some((w) => force.test(w) || /^\+\S/.test(w) || /^:\S/.test(w)))
        reasons.add("no force push or remote delete");
      // The branch may be quoted, and may end the step with a closing bracket right after it.
      if (after.some((w) => /^([^:]*:)?(refs\/heads\/)?(main|master)\)*$/i.test(w))) reasons.add("never push to main");
    }
  }
  return [...reasons];
}

function violationsIn(command: string, ticket?: string): string[] {
  if (command.length > MAX_COMMAND_CHARS)
    return [`a command over ${MAX_COMMAND_CHARS} characters can't be checked; put long text in a file`];
  const reasons = [
    ...[...COMMAND_RULES, ...SECRET_RULES].filter(([pattern]) => pattern.test(command)).map(([, reason]) => reason),
    ...stepViolations(command),
  ];
  // Node's environment under any spelling (`const {env} = process`, `require("process").env`, `Reflect.get(process,
  // "env")`): once one variable by name (`process.env.NAME`) is set aside, `process` and `env` together are a
  // read of the whole environment.
  const named = command.replace(/\bprocess\s*\.\s*env\s*\.\s*[A-Za-z_]\w*/g, "");
  if (/\bprocess\b/.test(named) && /\benv\b/.test(named))
    reasons.push(
      "no reading the whole environment (process.env); one variable by name, process.env.FAULTFORGE_TICKET_FILE, is fine",
    );
  if (INTERPRETER.test(command)) {
    for (const [pattern, reason] of BUILT_NAMES) if (pattern.test(named)) reasons.push(reason);
  }
  // A request, by a tool or by code, may only name the app on localhost, and must name it: a URL built at
  // run time (a variable, a decoded string) can't be checked, so it is refused.
  if (HTTP_TOOLS.test(command) || NETWORK_CODE.test(command)) {
    // Each call from code needs a local URL of its own: one localhost URL beside a second call whose address
    // is built at run time doesn't vouch for that one.
    const calls = [...command.matchAll(new RegExp(NETWORK_CODE.source, "g"))].length;
    if (!onlyLocalCalls(command, calls)) reasons.push(NETWORK_REASON);
  }
  if (ticket && /^\d+$/.test(ticket)) {
    const live = [
      // Any issue view, list or status, whatever the number is written as ($VAR, "$N", #N, a URL).
      /\bgh\s+issue\s+(view|list|status)\b/,
      // Search can return issue bodies.
      /\bgh\s+search\b/,
    ];
    // GraphQL can read any issue: `gh` and `graphql` anywhere, each found once (linear).
    const graphql = /\bgh\b/i.test(command) && /\bgraphql\b/i.test(command);
    // Any gh api call in a command that mentions issues or search anywhere, in any order (a path can be
    // built in a variable first). Deliberately broad: a rule that lists endpoints can't keep up with new
    // spellings. The agent doesn't need these: review:wait saves the review comments.
    const apiOnIssues = /\bgh\b/i.test(command) && /\bapi\b/i.test(command) && /\b(issues|search)\b/i.test(command);
    if (graphql || apiOnIssues || live.some((pattern) => pattern.test(command))) {
      reasons.push("read the ticket from the runner's snapshot file, not live from GitHub");
    }
  }
  return reasons;
}

/**
 * The ways a shell reads a backslash or backtick before a newline. Bash removes a backslash-newline pair
 * outright, so a name split across lines (`review:\` newline `wait`) runs as one word. PowerShell reads a
 * backtick-newline as a separator. And in Bash a backtick before a newline opens a command substitution, so
 * the words around it stay apart (`true` backtick newline `git push --force …` backtick runs the push). No
 * rule can know which shell will run the text, so every rule reads the command both ways, glued and spaced,
 * and a violation in either reading counts: the rules fail closed.
 *
 * Each of those is also read as the words it runs: empty quotes, escaped letters, `${x}` and ANSI-C
 * strings removed or decoded (`g''h pr merge`, `\gh`, `$'\x67h'`), and once more with a program's punctuation
 * read as spaces, so `execFileSync('g'+'h', ['pr', 'merge'])` meets the same rules as `gh pr merge`.
 */
export function readings(raw: string): string[] {
  return [...new Set(continued(raw).flatMap((text) => [text, spokenWords(text), codeAsWords(text)]))];
}

/** The command with each backslash or backtick before a newline read both ways: glued, and as a space. */
function continued(raw: string): string[] {
  const continuation = /[\\`]\r?\n/g;
  return [raw.replace(continuation, ""), raw.replace(continuation, " ")];
}

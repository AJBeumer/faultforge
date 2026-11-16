/**
 * The door rule (#340). Every write to a reviewed repository goes through one harness command,
 * `npm run target:post` (`packages/harness/src/target-post.ts`), which checks the exact text it sends. So the guard
 * no longer reads what a raw write to a reviewed repository would say: it refuses the raw write and names the door.
 *
 *  - `doorCommand`: a command that is exactly `npm run target:post -- <plain words>` on one line, run from the lab's
 *    own checkout whose `package.json` still runs the door and nothing before or after it, passes without its text
 *    being read.
 *  - `sendsRaw`: a command that sends to a remote some other way: a push, a gh call that isn't a known read, or an
 *    HTTP write. The guard refuses it where it reaches a reviewed repo.
 *  - `mcpReads`: an MCP tool whose name says it only reads; any other tool naming a reviewed repo is refused.
 * Script files that could write to a reviewed repo are refused in guard-files.ts (`scriptProblem`), and inline
 * interpreter code that starts a program or reaches the network everywhere, in shell-exec.ts.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LAB_ROOT } from "../shared/repos.ts";
import { gitSteps, joinedWords, quotedSpans } from "../shell/scan.ts";
import { type Call, calls } from "./history.ts";
import { HTTP_CLIENT, httpSends, isSend } from "./reach.ts";

/** What `package.json` must run for `target:post`: the door, and nothing else. */
export const DOOR_SCRIPT = "node packages/harness/src/target-post-cli.ts";

/** The refusal for a raw write to a reviewed repo. */
export function doorReason(name: string): string {
  return `Writes to ${name} go only through the door, which checks the exact text it sends: npm run target:post -- <kind> ... (issue-create, issue-edit, issue-comment, pr-create, pr-edit, pr-comment, pr-close, push; options in packages/harness/src/target-post.ts). Write the text to a file and pass the file. Run it on its own from the lab's checkout.`;
}

/** The refusal for a write whose destination the guard can't read. */
export const UNKNOWN_DESTINATION =
  "This sends to a repo the guard can't read from the command (a shell variable, a script, built text). If it is a reviewed repo, use npm run target:post; otherwise name the repo as owner/name in the command.";

/** One plain argument: a word without shell syntax, or a quoted one without expansions. Never a line break. */
const ARG = String.raw`(?:[\w./:=@+,~-]+|'[^'\n\r]*'|"[^"$\x60\\\n\r]*")`;
const DOOR = new RegExp(String.raw`^npm[ \t]+run[ \t]+target:post(?:[ \t]+--(?:[ \t]+${ARG})*)?[ \t]*$`);

const same = (a: string, b: string) => {
  try {
    return realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();
  } catch {
    return false;
  }
};

/**
 * True when the command is exactly the door: `npm run target:post -- …` on one line with plain arguments (no
 * expansion, redirect, line break or second command), run from `root`, the lab checkout the guard runs from, whose
 * `package.json` runs `DOOR_SCRIPT` for it with no `pre` or `post` script around it, and whose `.npmrc` sets no
 * shell, node option or script setting that could run something else. npm puts every `node_modules/.bin` from the
 * root up ahead of `PATH`, so a `node` in one of them would run instead of Node itself: none may be there (Qodo on
 * PR 344). Anything else is judged like any other command.
 */
export function doorCommand(command: string, cwd: string, root = LAB_ROOT): boolean {
  if (!DOOR.test(command.trim()) || !same(cwd, root)) return false;
  try {
    const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
    if (scripts["target:post"] !== DOOR_SCRIPT || scripts["pretarget:post"] || scripts["posttarget:post"]) return false;
    const npmrc = join(root, ".npmrc");
    if (
      existsSync(npmrc) &&
      /script-shell|node-options|ignore-scripts|scripts-prepend/i.test(readFileSync(npmrc, "utf8"))
    )
      return false;
    for (let dir = resolve(root); ; dir = dirname(dir)) {
      const bin = join(dir, "node_modules", ".bin");
      if (existsSync(bin) && readdirSync(bin).some((name) => /^node(\.(exe|cmd|bat|ps1|com))?$/i.test(name)))
        return false;
      if (dirname(dir) === dir) return true;
    }
  } catch {
    return false;
  }
}

/** The gh calls that only read: the group and verb (after `-R`/`--repo` and its value), or an API GET. */
const GH_READS =
  /^(?:(?:pr|issue) (?:view|list|status|checks|diff|checkout)|repo (?:view|list|clone)|(?:run|release|workflow|gist|ruleset|cache) (?:view|list|watch|download|check)|label list|auth status|search \S+|status|browse|help|version|completion|(?:secret|variable) list)$/;

/** True when a gh call only reads from GitHub. */
export function ghReads(args: string[]): boolean {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i] ?? "";
    if (/^(-R|--repo)$/.test(word)) i++;
    else if (!word.startsWith("-")) words.push(word);
  }
  if (!words.length) return args.every((a) => /^(--version|--help|-h)$/.test(a));
  if (words[0] === "api") {
    const methods = args.flatMap((a, i) =>
      /^(-X|--method)$/.test(a) ? [args[i + 1] ?? ""] : (/^(?:-X|--method=)(.+)$/.exec(a)?.slice(1) ?? []),
    );
    const sends = args.some((a) => /^(-[fF]|--field|--raw-field|--input)(=|$)|^-[fF]./.test(a));
    return !sends && methods.every((m) => /^get$/i.test(m)) && words[1] !== "graphql";
  }
  return GH_READS.test(words.slice(0, 2).join(" ")) || GH_READS.test(words[0] ?? "");
}

/** True when an HTTP call sends something (`httpSends`), read with the client it runs. */
function webSends(call: Call): boolean {
  return httpSends(HTTP_CLIENT.exec(` ${call.text}`)?.[1] ?? "curl", call.args);
}

/**
 * True when the command pushes: git's own subcommand is `push` or `send-pack` (so `push` in a commit message,
 * `git stash push` or `git config push.default` is none), or, as written with quoted text blanked, a git step
 * names one in a spelling the parser didn't follow.
 */
function pushes(command: string, found: Call[]): boolean {
  if (found.some((call) => call.program === "git" && /^(push|send-pack)$/.test(call.args[0] ?? ""))) return true;
  // Quoted text with a space in it is a message, not a word; quote marks inside a word (`pu''sh`) join it.
  let text = command;
  for (const span of quotedSpans(command).reverse()) {
    if (/\s/.test(command.slice(span.start + 1, span.end - 1))) {
      text = `${text.slice(0, span.start)} ${text.slice(span.end)}`;
    }
  }
  const words = joinedWords(text);
  return gitSteps(words, /(?<![\w./-])(?<!\bstash\s+)(push|send-pack)(?![\w.-])/).length > 0;
}

/**
 * True when the command sends to a remote other than through the door: a push, a gh or raw API write (`isSend`), a
 * gh call that isn't a known read (`ghReads`, so `gh pr -R o/n merge` counts), or an HTTP client that sends a body
 * or a method.
 */
export function sendsRaw(command: string, cwd: string, backticks: boolean): boolean {
  if (isSend(command)) return true;
  const found = calls(command, cwd, backticks);
  if (pushes(command, found)) return true;
  return found.some((call) =>
    call.program === "gh" ? !ghReads(call.args) : call.program === "web" ? webSends(call) : false,
  );
}

/** True when an HTTP write in the command has an argument the guard can't read: its URL could be any repo's. */
export function webToUnknown(command: string, cwd: string, backticks: boolean): boolean {
  return calls(command, cwd, backticks).some(
    (call) => call.program === "web" && webSends(call) && call.args.some((a) => /[$`%]/.test(a)),
  );
}

/**
 * True when an MCP tool's name says it only reads: a reading verb among its words (`get_issue`, `issue_read`,
 * `list_pull_requests`) and no writing one.
 */
export function mcpReads(tool: string): boolean {
  const words = (tool.split("__").at(-1) ?? "").toLowerCase().split(/[_-]/);
  const reads = words.some((w) => /^(get|list|search|read|view|fetch|download)$/.test(w));
  const writes = words.some((w) =>
    /^(create|update|delete|add|push|merge|write|edit|close|comment|remove|set|fork|lock|reopen|submit|assign|dismiss|upload|rename|transfer)$/.test(
      w,
    ),
  );
  return reads && !writes;
}

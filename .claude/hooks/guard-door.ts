/**
 * The door rule (#340). Every write to a reviewed repository goes through one harness command,
 * `npm run target:post` (`packages/harness/src/target-post.ts`), which checks the exact text it sends. So the guard
 * no longer reads what a raw write to a reviewed repository would say: it refuses the raw write and names the door.
 *
 *  - `doorCommand`: a command that is exactly `npm run target:post -- <plain words>`, run from the lab's own
 *    checkout whose `package.json` still runs the door, passes without its text being read.
 *  - `sendsRaw`: a command that sends to a remote some other way: a push, a gh call that isn't a known read, or an
 *    HTTP write. The guard refuses it where it reaches a reviewed repo.
 *  - `mcpReads`: an MCP tool whose name says it only reads; any other tool naming a reviewed repo is refused.
 * Script files that could write to a reviewed repo are refused in guard-files.ts (`scriptProblem`), and inline
 * interpreter code that starts a program or reaches the network everywhere, in shell-exec.ts.
 */
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type Call, calls } from "./guard-history.ts";
import { isSend } from "./guard-reach.ts";
import { LAB_ROOT } from "./guard-repos.ts";

/** What `package.json` must run for `target:post`: the door, and nothing else. */
export const DOOR_SCRIPT = "tsx packages/harness/src/target-post-cli.ts";

/** The refusal for a raw write to a reviewed repo. */
export function doorReason(name: string): string {
  return `Writes to ${name} go only through the door, which checks the exact text it sends: npm run target:post -- <kind> ... (issue-create, issue-edit, issue-comment, pr-create, pr-edit, pr-comment, pr-close, push; options in packages/harness/src/target-post.ts). Write the text to a file and pass the file. Run it on its own from the lab's checkout.`;
}

/** The refusal for a write whose destination the guard can't read. */
export const UNKNOWN_DESTINATION =
  "This sends to a repo the guard can't read from the command (a shell variable, a script, built text). If it is a reviewed repo, use npm run target:post; otherwise name the repo as owner/name in the command.";

/** One plain argument: a word without shell syntax, or a quoted one without expansions. */
const ARG = String.raw`(?:[\w./:=@+,~-]+|'[^']*'|"[^"$\x60\\]*")`;
const DOOR = new RegExp(String.raw`^npm\s+run\s+target:post(?:\s+--(?:\s+${ARG})*)?\s*$`);

const same = (a: string, b: string) => {
  try {
    return realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();
  } catch {
    return false;
  }
};

/**
 * True when the command is exactly the door: `npm run target:post -- …` with plain arguments (no expansion,
 * redirect or second command), run from `root`, the lab checkout the guard runs from, whose `package.json` runs
 * `DOOR_SCRIPT` for it. Anything else is judged like any other command.
 */
export function doorCommand(command: string, cwd: string, root = LAB_ROOT): boolean {
  if (!DOOR.test(command.trim()) || !same(cwd, root)) return false;
  try {
    const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
    return scripts["target:post"] === DOOR_SCRIPT;
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

/** Options that make an HTTP client send a body or another method than GET. */
const WEB_WRITE =
  /^(-X|--request|-d|--data\S*|--json|--form|-F|--post-data|--post-file|--upload-file|-T|--method|-Method|-Body|-InFile)$|^(-X|--request=|--data\S*=|-d)./i;

/** True when an HTTP call sends something: a body, or a method other than GET or HEAD. */
function webSends(call: Call): boolean {
  return call.args.some((a, i) => {
    if (!WEB_WRITE.test(a)) return false;
    const value = /^(-X|--request|-Method|--method)$/i.test(a) ? (call.args[i + 1] ?? "") : "";
    return !/^(GET|HEAD)$/i.test(value);
  });
}

/**
 * True when the command sends to a remote other than through the door: a push or any gh or raw API write
 * (`isSend`), a gh call that isn't a known read (`ghReads`, so `gh pr -R o/n merge` counts), or an HTTP client that
 * sends a body or a method.
 */
export function sendsRaw(command: string, cwd: string, backticks: boolean): boolean {
  if (isSend(command)) return true;
  return calls(command, cwd, backticks).some((call) =>
    call.program === "gh" ? !ghReads(call.args) : call.program === "web" ? webSends(call) : false,
  );
}

/** True when an HTTP write in the command goes to a URL the guard can't read (a variable or built text). */
export function webToUnknown(command: string, cwd: string, backticks: boolean): boolean {
  return calls(command, cwd, backticks).some(
    (call) =>
      call.program === "web" && webSends(call) && !call.args.some((a) => /^https?:\/\//i.test(a) && !/[$`%]/.test(a)),
  );
}

/** True when an MCP tool's name says it only reads (`get_`, `list_`, `search_`, `read_` and the like). */
export function mcpReads(tool: string): boolean {
  const name = tool.split("__").at(-1) ?? "";
  return /^(get|list|search|read|view|fetch|download)(_|$)/i.test(name);
}

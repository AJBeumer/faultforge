/**
 * The command as the shell would read it before it posts anything (#285, AUD-M3): ANSI-C strings decoded, the
 * variables the command itself sets expanded, percent-encoded API routes decoded, and a repository given by
 * its numeric id named. The guard judges this reading beside the command as written; text it still can't
 * read (a variable the command doesn't set) is refused where it would be posted.
 */
import { spawnSync } from "node:child_process";
import { outsidePostedText, postedRanges } from "./guard-posted.ts";
import { isWrite } from "./guard-reach.ts";
import { decodeAnsiC } from "./shell-decode.ts";
import { joinedWords, quotedMask, quotedSpans } from "./shell-scan.ts";

/** A variable's name in shell text: `$NAME`, `${NAME}`, PowerShell's `$env:NAME`. Not `$(`, `$1` or `$?`. */
export const VARIABLE = /\$\{?[A-Za-z_]\w*/;

/** A statement that only sets variables to plain text: `A=x`, `export A="x" B='y'`. */
// A bare value with a backslash is not taken: the shell removes it, and the value it holds is another word
// (`M=pla\nted` holds `planted`; Qodo on PR 291), so the variable stays unreadable.
const ASSIGNS_ONLY =
  /^\s*(?:(?:export|local|declare|readonly)\s+)?(?:[A-Za-z_]\w*=(?:"[^"$`\\]*"|'[^']*'|[^\s;&|$`'"()<>\\]*)\s*)+$/;
const ASSIGNMENT = /([A-Za-z_]\w*)=(?:"([^"$`\\]*)"|'([^']*)'|([^\s;&|$`'"()<>\\]*))/g;
// PowerShell's `$NAME = 'x'` and `$env:NAME = 'x'`, read the same way as its uses.
const POWERSHELL_ASSIGN = /^\s*\$(?:env:)?([A-Za-z_]\w*)\s*=\s*(?:"([^"$`]*)"|'([^']*)')\s*$/i;

/**
 * The variables the command sets to plain text, replaced where the shell would use them (Qodo on PR 291): a
 * statement of its own (`NAME=value`, `export NAME=value`, PowerShell's `$NAME = 'value'`) sets a value for
 * the statements after it, never before; a prefix (`NAME=value cmd`) doesn't change how `cmd`'s words expand,
 * and `NAME=value` inside an argument sets nothing. A value that is itself built (`$`, a backtick) is not
 * taken: it stays unreadable.
 */
export function expandVariables(command: string): string {
  const quoted = quotedMask(command);
  const assigned = new Map<string, string>();
  let out = "";
  let start = 0;
  const statement = (end: number) => {
    const text = command.slice(start, end);
    const powershell = POWERSHELL_ASSIGN.exec(text);
    if (ASSIGNS_ONLY.test(text)) {
      for (const m of text.matchAll(ASSIGNMENT)) assigned.set(m[1] ?? "", m[2] ?? m[3] ?? m[4] ?? "");
      out += text;
    } else if (powershell) {
      assigned.set(powershell[1] ?? "", powershell[2] ?? powershell[3] ?? "");
      out += text;
    } else {
      let read = text;
      for (const [name, value] of assigned)
        read = read.replace(new RegExp(String.raw`\$\{${name}\}|\$(?:env:)?${name}(?!\w)`, "gi"), () => value);
      out += read;
    }
  };
  for (let i = 0; i < command.length; i++) {
    if (quoted[i] || !/[;&|\n]/.test(command[i] ?? "")) continue;
    statement(i);
    out += command[i];
    start = i + 1;
  }
  statement(command.length);
  return out;
}

/** `%2D` and its kind decoded in a GitHub route (`repos/o/faultforge%2Dtarget`), as GitHub decodes them. */
function decodeRoutes(command: string): string {
  return command.replace(/\b(repos|repositories)\/[^\s"']+/gi, (route) => {
    try {
      return decodeURIComponent(route);
    } catch {
      return route;
    }
  });
}

/** Resolves a numeric repository id to `owner/name`, or undefined when it can't. */
export type RepositoryResolver = (id: string, timeoutMs: number) => string | undefined;

/** Asks GitHub, through gh, which repo an id is. */
const ghResolver: RepositoryResolver = (id, timeoutMs) => {
  const result = spawnSync("gh", ["api", `repositories/${id}`, "--jq", ".full_name"], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  const name = result.status === 0 ? result.stdout.trim() : "";
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? name : undefined;
};

let resolver: RepositoryResolver = ghResolver;

/** For the tests: a resolver that doesn't reach GitHub. Returns the one it replaced. */
export function setRepositoryResolver(next: RepositoryResolver): RepositoryResolver {
  const before = resolver;
  resolver = next;
  return before;
}

/** Thrown when a command names a repository by an id the guard can't resolve. */
export class UnknownRepository extends Error {}

/**
 * `repositories/<id>` routes rewritten as `repos/<owner>/<name>` (#285): an id hides which repo a write goes
 * to, so the guard asks GitHub. An id it can't resolve, in time or at all, throws: it can't be proven not to
 * be a reviewed repo, so the write is refused.
 */
export function nameRepositories(command: string, timeoutMs = 4000): string {
  // Only a route the command acts on: an id in a posted message is words (Qodo on PR 291).
  const outside = outsidePostedText(command);
  const ids = [...new Set([...outside.matchAll(/\brepositories\/(\d+)/gi)].map((m) => m[1] ?? ""))];
  let text = command;
  for (const id of ids) {
    const name = resolver(id, timeoutMs);
    if (!name) {
      throw new UnknownRepository(
        `This command names a repository by its id (${id}), and the guard couldn't tell which repo that is. Name the repo as owner/name instead.`,
      );
    }
    text = text.replace(new RegExp(String.raw`\brepositories\/${id}(?!\d)`, "gi"), `repos/${name}`);
  }
  return text;
}

/**
 * The command as the shell would read it: ANSI-C decoded, its own variables expanded, routes decoded, and
 * (for a write) repository ids named. Equal to the command when none of those apply.
 */
export function shellReading(command: string, timeoutMs?: number): string {
  const read = decodeRoutes(expandVariables(decodeAnsiC(command)));
  // A write in either reading: `-X $M` with `M=PUT` is one only once expanded (Qodo on PR 291).
  return isWrite(command) || isWrite(read) ? nameRepositories(read, timeoutMs) : read;
}

/** Why the command may not run because it hides a later post behind an alias, or undefined. */
export function aliasProblem(command: string): string | undefined {
  // Also a gh whose subcommand is a variable or a substitution: it could be `alias` (Qodo on PR 291).
  if (/\bgh\s+alias\s+(set|import)\b/i.test(joinedWords(command)) || /\bgh\s+["']?(\$|`)/.test(command))
    return "gh aliases hide what a later command posts, and where, from the guard. Run the full command instead.";
  return undefined;
}

/**
 * True when a posted value still holds a variable the command doesn't set: its text can't be read. The whole
 * shell word counts, every quoted part of it (`'safe '"$MSG"`; Qodo on PR 291), but not single-quoted text,
 * an escaped `\$`, or a variable inside a substitution, which builtText reads or refuses.
 */
export function unreadablePost(command: string): boolean {
  return postedRanges(command).some(([start, end]) => {
    // Single-quoted parts as the shell reads them: an apostrophe inside double quotes is a letter (Qodo on PR 291).
    const word = command.slice(start, end);
    let text = "";
    let at = 0;
    for (const span of quotedSpans(word).filter((s) => s.kind === "single")) {
      text += word.slice(at, span.start);
      at = span.end;
    }
    text += word.slice(at);
    return VARIABLE.test(text.replace(/\\\$/g, "").replace(/\$\([^)]*\)?/g, ""));
  });
}

/** True when the repo a write goes to is a variable the command doesn't set: where it goes can't be read. */
export function unreadableDestination(command: string): boolean {
  return /(?:--repo|(?<=\s)-R)[\s=]*["']?\$|\bGH_REPO\s*=\s*["']?\$/.test(command);
}

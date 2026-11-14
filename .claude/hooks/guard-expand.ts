/**
 * The command as the shell would read it before it posts anything (#285, AUD-M3): ANSI-C strings decoded, the
 * variables the command itself sets expanded, percent-encoded API routes decoded, and a repository given by
 * its numeric id named. The guard judges this reading beside the command as written; text it still can't
 * read (a variable the command doesn't set) is refused where it would be posted.
 */
import { spawnSync } from "node:child_process";
import { decodeAnsiC } from "./shell-decode.ts";
import { joinedWords } from "./shell-scan.ts";

/** A variable's name in shell text: `$NAME`, `${NAME}`, PowerShell's `$env:NAME`. Not `$(`, `$1` or `$?`. */
export const VARIABLE = /\$\{?[A-Za-z_]\w*/;

/**
 * The variables the command sets to plain text (`NAME=value`, `export NAME=value`, PowerShell's
 * `$NAME = 'value'`), each replaced where it is used. A value that is itself built (`$`, a backtick) is left
 * alone: it is still unreadable. Every use is replaced, wherever it sits, so a quoted `'$NAME'` reads as the
 * value too; that can only add text to check.
 */
export function expandVariables(command: string): string {
  const assigned = new Map<string, string>();
  const bash =
    /(?:^|[;&|\n(]\s*|\s)(?:export\s+|local\s+|declare\s+|readonly\s+)?([A-Za-z_]\w*)=("([^"$`\\]*)"|'([^']*)'|([^\s;&|$`'"()<>]*))(?=[\s;&|)]|$)/g;
  for (const m of command.matchAll(bash)) assigned.set(m[1] ?? "", m[3] ?? m[4] ?? m[5] ?? "");
  const powershell = /\$([A-Za-z_]\w*)\s*=\s*(?:"([^"$`]*)"|'([^']*)')/g;
  for (const m of command.matchAll(powershell)) assigned.set(m[1] ?? "", m[2] ?? m[3] ?? "");
  let text = command;
  for (const [name, value] of assigned) {
    text = text.replace(new RegExp(String.raw`\$\{${name}\}|\$${name}(?!\w)`, "g"), () => value);
  }
  return text;
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
  const ids = [...new Set([...command.matchAll(/\brepositories\/(\d+)/gi)].map((m) => m[1] ?? ""))];
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
export function shellReading(command: string, writes: boolean, timeoutMs?: number): string {
  const read = decodeRoutes(expandVariables(decodeAnsiC(command)));
  return writes ? nameRepositories(read, timeoutMs) : read;
}

/** Why the command may not run because it hides a later post behind an alias, or undefined. */
export function aliasProblem(command: string): string | undefined {
  if (/\bgh\s+alias\s+(set|import)\b/i.test(joinedWords(command)))
    return "gh aliases hide what a later command posts, and where, from the guard. Run the full command instead.";
  return undefined;
}

/** True when a value posted as text still holds a variable the command doesn't set: its text can't be read. */
export function unreadableValue(values: string[]): boolean {
  // A variable inside a substitution is the substitution's: builtText reads that, or refuses it.
  return values.some((value) => VARIABLE.test(value.replace(/\$\([^)]*\)?/g, "")));
}

/** True when the repo a write goes to is a variable the command doesn't set: where it goes can't be read. */
export function unreadableDestination(command: string): boolean {
  return /(?:--repo|(?<=\s)-R)[\s=]*["']?\$|\bGH_REPO\s*=\s*["']?\$/.test(command);
}

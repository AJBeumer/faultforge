/**
 * The door kinds an unattended run's agent may use (#347). The door (`npm run target:post`, #340) writes to the
 * reviewed repository; during a run the agent needs only to push its branch, open its PR and change it. Commenting
 * on a PR, closing one and writing issues stay with the owner and the runner, so an agent can't talk on a PR or
 * close one, however the text is worded (Qodo on PR 346). `AGENT_DOOR_KINDS` is the one list: the policy reads it
 * here, and the agent's prompt (`factory-agent-door.ts`) reads it to name the commands it may run.
 *
 * Split from factory-policy-commands.ts, which is near the module size limit.
 */
import { joinedWords, segments } from "./shell-scan.ts";

/** The door kinds an agent may use during a run. */
export const AGENT_DOOR_KINDS = ["push", "pr-create", "pr-edit"] as const;
export type AgentDoorKind = (typeof AGENT_DOOR_KINDS)[number];

/**
 * The door's other kinds: `target-post.ts`'s `COMMAND_KINDS` without the allowed ones (a test keeps the two in
 * step). The hooks don't import the harness, so the names are written out here.
 */
export const OWNER_DOOR_KINDS = ["issue-create", "issue-edit", "issue-comment", "pr-comment", "pr-close"] as const;

/** The refusal, naming the kinds that are allowed. */
export const DOOR_KIND_REASON = `in a run the door (npm run target:post) takes only ${AGENT_DOOR_KINDS.join(", ")}: commenting on or closing a PR and writing issues stay with the owner and the runner`;

/** The refusal for a script runner whose script or subcommand is built at run time. */
export const BUILT_SCRIPT_REASON =
  "name the npm script in the command (npm run target:post, npm run check): a script name built at run time (a variable, a substitution) can't be checked";

/** Package managers, which run a script with `run` (and yarn, pnpm and bun without it). */
const PACKAGE_MANAGERS = /^(npm|pnpm|yarn|bun)$/;
/** The subcommands that run a script, with npm's aliases, and Node's own flag (`node --run x`). */
const RUN_WORDS = /^(run|run-script|rum|urn|--run)$/;
/** Programs that run a module by path or inline code. */
const INTERPRETERS = /^(node|nodejs|tsx|ts-node|bun|deno|npx|vite-node)$/;
/** Text the shell would change before the program sees it: a variable, a substitution, a glob, a brace. */
const BUILT = /[$`%*?{}()[\]]/;

/** The program a word names, however it is written: `/usr/bin/node`, `node.exe`. */
const program = (word: string) => (word.split(/[\\/]/).pop() ?? "").replace(/\.(exe|cmd)$/i, "").toLowerCase();

/** True when the word is the door's module by path (`…/target-post-cli.ts`, `…/target-post.ts`). */
const doorModule = (word: string) => /^target-post(-cli)?(\.[cm]?[jt]s)?$/i.test(word.split(/[\\/]/).pop() ?? "");

const ALLOWED: readonly string[] = AGENT_DOOR_KINDS;
const OWNER: readonly string[] = OWNER_DOOR_KINDS;

/** The index of the first word from `from` on that isn't an option, or -1. */
function firstPlain(words: string[], from: number): number {
  for (let i = from; i < words.length; i++) if (!(words[i] ?? "").startsWith("-")) return i;
  return -1;
}

/** Why the kind after the door's name at `at` isn't allowed, or undefined. No kind sends nothing. */
function kindAfter(words: string[], at: number): string | undefined {
  const kind = firstPlain(words, at + 1);
  return kind >= 0 && !ALLOWED.includes(words[kind] ?? "") ? DOOR_KIND_REASON : undefined;
}

/** Why a package script this step runs may not run, or undefined. */
function scriptViolation(words: string[], programs: string[]): string | undefined {
  const manager = programs.findIndex((p) => PACKAGE_MANAGERS.test(p));
  const node = programs.findIndex((p) => p === "node" || p === "nodejs");
  let script = -1;
  if (manager >= 0) {
    // The subcommand: `run`, or for yarn, pnpm and bun the script itself.
    const sub = firstPlain(words, manager + 1);
    if (sub >= 0 && BUILT.test(words[sub] ?? "")) return BUILT_SCRIPT_REASON;
    script = sub >= 0 && RUN_WORDS.test(words[sub] ?? "") ? firstPlain(words, sub + 1) : sub;
  } else if (node >= 0) {
    const flag = words.findIndex((w, i) => i > node && w === "--run");
    if (flag >= 0) script = firstPlain(words, flag + 1);
  }
  if (script < 0) return undefined;
  const name = words[script] ?? "";
  if (BUILT.test(name)) return BUILT_SCRIPT_REASON;
  return name.toLowerCase() === "target:post" ? kindAfter(words, script) : undefined;
}

/** Why one step of a command may not run, or undefined. `words` are its words, quotes removed. */
function stepViolation(words: string[]): string | undefined {
  // A kind the agent may not use, wherever it stands: however the door's name is spelled or built, a kind
  // written out is still a word of the command.
  if (words.some((w) => OWNER.includes(w))) return DOOR_KIND_REASON;
  const programs = words.map(program);
  const script = scriptViolation(words, programs);
  if (script) return script;
  if (!programs.some((p) => INTERPRETERS.test(p))) return undefined;
  // The door's module run by path: its first plain word is the kind.
  const module = words.findIndex(doorModule);
  if (module >= 0 && kindAfter(words, module)) return DOOR_KIND_REASON;
  // The door's module named in inline code, or its send function (the runner's).
  const inCode = (w: string) => (/target-post/i.test(w) && /[()]/.test(w)) || /\bsendPost\b/.test(w);
  return words.some(inCode) ? DOOR_KIND_REASON : undefined;
}

/**
 * Why a command may not run in a run because of the door, or undefined. Each reading of the command (`readings` in
 * factory-policy-commands.ts: as written, decoded, and as code) is cut into steps, quotes ignored, so a door call
 * inside `bash -c "…"` or `$(…)` is read too. Each step's words are read with quotes removed, and once more with
 * backslashes removed too (`target\:post` is `target:post` to bash). A step is refused when:
 *  - any word is a door kind the agent may not use;
 *  - it runs a package script whose subcommand or name is built at run time (`npm run "$S"`), which can't be read;
 *  - it runs `target:post`, or the door's module by path, with a kind that isn't allowed (a variable included);
 *  - an interpreter names the door's module in inline code, or `sendPost`.
 * Reading the door's files (`cat …/target-post.ts README`, `grep sendPost …`) runs nothing and passes (Qodo on PR
 * 349). Each test reads a step's words a fixed number of times, so the rule stays linear in the command.
 */
export function doorKindViolation(readings: string[]): string | undefined {
  for (const reading of readings) {
    for (const { text } of segments(reading)) {
      const joined = joinedWords(text);
      for (const spelled of [joined, joined.replace(/\\/g, "")]) {
        const reason = stepViolation(spelled.split(/\s+/).filter(Boolean));
        if (reason) return reason;
      }
    }
  }
  return undefined;
}

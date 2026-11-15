/**
 * The door kinds an unattended run's agent may use (#347). The door (`npm run target:post`, #340) writes to the
 * reviewed repository; during a run the agent needs only to push its branch, open its PR and change it. Commenting
 * on a PR, closing one and writing issues stay with the owner and the runner, so an agent can't talk on a PR or
 * close one, however the text is worded (Qodo on PR 346). `AGENT_DOOR_KINDS` is the one list: the policy reads it
 * here, and the agent's prompt (`factory-agent-door.ts`) reads it to name the commands it may run.
 *
 * The door reads its kind only from its arguments, so the rule needs to see two things: what runs the door, and
 * the kind it is given. Both must be written out in the command; what the shell or a program would build at run
 * time is refused, because it can't be read. A command that runs no code (`cat`, `grep`) is left alone.
 *
 * Split from factory-policy-commands.ts, which is near the module size limit.
 */
import { readings } from "./factory-policy-commands.ts";
import { joinedWords, segments } from "./shell-scan.ts";

/** The door kinds an agent may use during a run. */
export const AGENT_DOOR_KINDS = ["push", "pr-create", "pr-edit"] as const;
export type AgentDoorKind = (typeof AGENT_DOOR_KINDS)[number];

/** The refusal, naming the kinds that are allowed. */
export const DOOR_KIND_REASON = `in a run the door (npm run target:post) takes only ${AGENT_DOOR_KINDS.join(", ")}, written out after it: commenting on or closing a PR and writing issues stay with the owner and the runner`;

/** The refusal for a script, module or path that is built at run time. */
export const BUILT_SCRIPT_REASON =
  "write out what runs (npm run target:post, node path/to/file.ts, import('./x.ts')): a script, module or path built at run time (a variable, a substitution, joined strings) can't be checked";

/** Package managers, which run scripts: `npm run x`, `yarn x`. */
const PACKAGE_MANAGERS = /^(npm|pnpm|yarn|bun)$/;
/** Programs that run a module by path or inline code. */
const INTERPRETERS = /^(node|nodejs|tsx|ts-node|bun|deno|npx|vite-node)$/;
/** The flags after which an interpreter's next word is code, not a path. */
const CODE_FLAGS = /^(-e|-p|-pe|-ep|--eval|--print)$/;
/** Text the shell or a program would change before it runs: a variable, a substitution, a glob, a brace, a join. */
const BUILT = /[$`%*?{}()[\]+]/;

/** The program a word names, however it is written: `/usr/bin/node`, `node.exe`. */
const program = (word: string) => (word.split(/[\\/]/).pop() ?? "").replace(/\.(exe|cmd)$/i, "").toLowerCase();

/** True when the word is the door's module by path (`…/target-post-cli.ts`, `…/target-post.ts`). */
const doorModule = (word: string) => /^target-post(-cli)?(\.[cm]?[jt]s)?$/i.test(word.split(/[\\/]/).pop() ?? "");

const ALLOWED: readonly string[] = AGENT_DOOR_KINDS;

/** The words of a text, split at white space. */
const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean);

/**
 * Why one step may not run, or undefined. `words` are its words, quotes removed. Called only for a command that
 * runs a package script or an interpreter somewhere (inline code may be cut into several steps at its `;`). One
 * pass over the words, so the rule stays linear in the command.
 */
function stepViolation(words: string[]): string | undefined {
  /** True after a door word, until its kind. */
  let awaitingKind = false;
  /** True from a package manager to `--`: its options and the script's name, which must be written out. */
  let managerWords = false;
  /** 1 right after an interpreter, 2 after one of its code flags; its first plain word is then a path, or code. */
  let interpreter = 0;
  const interpreted = words.some((w) => INTERPRETERS.test(program(w)));
  for (const word of words) {
    if (awaitingKind && !word.startsWith("-")) {
      if (!ALLOWED.includes(word)) return DOOR_KIND_REASON;
      awaitingKind = false;
    }
    if (managerWords && word === "--") managerWords = false;
    else if (managerWords && BUILT.test(word)) return BUILT_SCRIPT_REASON;
    if (interpreter && !word.startsWith("-")) {
      if (interpreter === 1 && BUILT.test(word)) return BUILT_SCRIPT_REASON;
      interpreter = 0;
    } else if (interpreter && CODE_FLAGS.test(word)) interpreter = 2;
    const name = program(word);
    if (PACKAGE_MANAGERS.test(name)) managerWords = true;
    if (INTERPRETERS.test(name)) interpreter = 1;
    if (word.toLowerCase() === "target:post") awaitingKind = true;
    if (interpreted && /target-post/i.test(word)) {
      // The door's module by path takes its kind next; any other spelling of it (`M=target-post.ts`, in code)
      // can't be read.
      if (doorModule(word)) awaitingKind = true;
      else if (/[$`()=+]/.test(word)) return BUILT_SCRIPT_REASON;
    }
    if (interpreted && /\bsendPost\b/.test(word)) return DOOR_KIND_REASON;
  }
  // A door word with no kind after it would take one from elsewhere (`… | xargs npm run target:post --`).
  return awaitingKind ? DOOR_KIND_REASON : undefined;
}

/**
 * True when code loads a module by a name that isn't one plain string: `import(x)`, `require("./" + m)`. A
 * backslash before a quote (`require(\"fs\")` inside a double-quoted shell string) is read as the quote.
 */
function builtImport(command: string): boolean {
  const text = command.replace(/\\(?=["'`])/g, "");
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*/g)) {
    const at = m.index + m[0].length;
    const quote = text[at] ?? "";
    if (!quote || !"'\"`".includes(quote)) return true;
    // A bounded look, so many loads stay linear: a module name is never 500 characters long.
    const close = text.slice(at + 1, at + 501).indexOf(quote);
    if (close < 0) return true;
    const end = at + 1 + close;
    if (/[$\\]/.test(text.slice(at + 1, end)) || !/^\s*\)/.test(text.slice(end + 1, end + 40))) return true;
  }
  return false;
}

/**
 * Why a command may not run in a run because of the door, or undefined. Only a command that runs a package script
 * or an interpreter is judged: one that runs no code (`grep -R pr-close src`, `cat …/target-post.ts README`)
 * passes (Qodo on PR 349). Each reading of it (as written, decoded, and as code: `readings`) is cut into steps,
 * quotes ignored, so a door call inside `bash -c "…"` or `$(…)` is read too, and each step's words are read with
 * quotes removed, and once more with backslashes removed (`target\:post` is `target:post` to bash). Then:
 *  - `target:post`, or the door's module by path, must be followed by an allowed kind, written out;
 *  - a package manager's options and script name (up to `--`), and an interpreter's script path, are written out;
 *  - the door's module named any other way (`M=target-post.ts`, in code) and `sendPost` (the runner's) are refused;
 *  - code may load a module only by one plain string (`import('./x.ts')`), never by a name it builds.
 */
export function doorKindViolation(command: string): string | undefined {
  const all = readings(command);
  const runsCode = all.some((reading) =>
    wordsOf(joinedWords(reading)).some((w) => PACKAGE_MANAGERS.test(program(w)) || INTERPRETERS.test(program(w))),
  );
  if (!runsCode) return undefined;
  if (builtImport(command)) return BUILT_SCRIPT_REASON;
  for (const reading of all) {
    for (const { text } of segments(reading)) {
      const joined = joinedWords(text);
      for (const spelled of [joined, joined.replace(/\\/g, "")]) {
        const reason = stepViolation(wordsOf(spelled));
        if (reason) return reason;
      }
    }
  }
  return undefined;
}

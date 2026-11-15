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

/** The refusal, naming the kinds that are allowed. */
export const DOOR_KIND_REASON = `in a run the door (npm run target:post) takes only ${AGENT_DOOR_KINDS.join(", ")}: commenting on or closing a PR and writing issues stay with the owner and the runner`;

/** A word that runs the door: its npm script, or its module by path (`…/target-post-cli.ts`, `…/target-post.ts`). */
const doorWord = (word: string) =>
  /^target:post$/i.test(word) || /^target-post(-cli)?(\.[cm]?[jt]s)?$/i.test(word.split(/[\\/]/).pop() ?? "");

/** Code that names the door's module inline (`node -e "import('./…/target-post.ts')…"`), in one word. */
const doorInCode = (word: string) => /target-post/i.test(word) && /[()]/.test(word);

/**
 * Why a command may not run in a run because of the door kind it uses, or undefined. Each reading of the command
 * (`readings` in factory-policy-commands.ts: as written, decoded, and as code) is cut into steps, quotes ignored, so
 * a door call inside `bash -c "…"` or `$(…)` is read too. After a door word, the first word that isn't an option is
 * the kind, and it must be one of `AGENT_DOOR_KINDS`: a variable, a quoted spelling the shell would change, or any
 * other word is refused, so the rule fails closed. A door word with nothing after it sends nothing (the door stops
 * with its usage), so `cat …/target-post.ts` passes. The door's module named in inline code (a word holding a
 * bracket) and its send function (`sendPost`, the runner's) are refused outright. Each test reads one word, so the
 * rule stays linear in the command.
 */
export function doorKindViolation(readings: string[]): string | undefined {
  for (const reading of readings) {
    if (/\bsendPost\b/.test(reading)) return DOOR_KIND_REASON;
    for (const { text } of segments(reading)) {
      const words = joinedWords(text).split(/\s+/).filter(Boolean);
      // True after a door word, until its kind: the first word after it that isn't an option.
      let awaitingKind = false;
      for (const word of words) {
        if (doorInCode(word)) return DOOR_KIND_REASON;
        if (awaitingKind && !word.startsWith("-")) {
          if (!(AGENT_DOOR_KINDS as readonly string[]).includes(word)) return DOOR_KIND_REASON;
          awaitingKind = false;
        }
        if (doorWord(word)) awaitingKind = true;
      }
    }
  }
  return undefined;
}

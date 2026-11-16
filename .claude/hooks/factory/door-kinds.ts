/**
 * The door kinds an unattended run's agent may use (#347), as a first, early word from the policy hook. The door
 * (`npm run target:post`, #340) writes to the reviewed repository; during a run the agent needs only to push its
 * branch, open its PR and change it.
 *
 * The guarantee is not here: it is in the door itself (`packages/harness/src/target-post-run.ts`), which refuses
 * every other kind while a run is marked active, however it is called. Reading a command's text can't see every
 * way to call the door (Qodo on PR 349 found several), so this rule only catches the plain spelling, a package
 * manager running `target:post` with a kind written out after it, and tells the agent before it tries. Anything
 * else is left to the door.
 */
import { AGENT_DOOR_KINDS } from "../../../packages/harness/src/target-post-run.ts";
import { joinedWords } from "../shell/scan.ts";
import { steps, words } from "../shell/words.ts";

export { AGENT_DOOR_KINDS };

/** The refusal, naming the kinds that are allowed. */
export const DOOR_KIND_REASON = `in a run the door (npm run target:post) takes only ${AGENT_DOOR_KINDS.join(", ")}: commenting on or closing a PR and writing issues stay with the owner and the runner, and the door itself refuses them`;

/** Package managers, which run scripts: `npm run x`, `yarn x`. */
const PACKAGE_MANAGER = /^(npm|pnpm|yarn|bun)(\.(cmd|ps1|exe))?$/i;
const ALLOWED: readonly string[] = AGENT_DOOR_KINDS;

/** Why a command may not run in a run because of the door kind it names, or undefined. */
export function doorKindViolation(command: string): string | undefined {
  // Split where the shell splits, so a `;` inside a quoted file name is part of that name (Qodo on PR 349).
  for (const { text } of steps(command, true)) {
    // The step's words, quotes removed, after any `NAME=value` it sets first.
    const all = words(text).map(joinedWords);
    const run = all.slice(
      Math.max(
        0,
        all.findIndex((word) => !/^\w+=/.test(word)),
      ),
    );
    if (!PACKAGE_MANAGER.test(run[0]?.split(/[\\/]/).pop() ?? "")) continue;
    const at = run.indexOf("target:post");
    if (at < 0) continue;
    const kind = run.slice(at + 1).find((word) => !word.startsWith("-"));
    if (kind !== undefined && !ALLOWED.includes(kind)) return DOOR_KIND_REASON;
  }
  return undefined;
}

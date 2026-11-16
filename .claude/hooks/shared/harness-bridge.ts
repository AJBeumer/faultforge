/**
 * The one way the hooks reach into the harness (#355). Every hook module that needs harness code imports it from
 * here, never from `packages/harness` itself, so this file is the whole list of what the guard runs from outside
 * `.claude`. Those files run before every tool call, so each is also one of the guard's own files
 * (`self/own-files.ts`) and fingerprinted before a factory run (`HOOK_IMPORTS` in the harness's
 * `factory-workspace.ts`). Add an import here only with a reason, and add its file to both lists.
 *
 * - `neutral.ts`, the giveaway word list: the guard reads posts with the same words the harness checks a case's
 *   branch, commit and PR text with, so one list decides both (`telltales`, `leetReadings`, `readerViews`).
 * - `target-post-run.ts`, the door's run gate: the door kinds a factory run's agent may use. The door enforces
 *   them; the policy hook names them early, from the same list (`AGENT_DOOR_KINDS`).
 *
 * Tests may import the harness directly, to check that both sides agree.
 */
export { leetReadings, readerViews, telltales } from "../../../packages/harness/src/neutral.ts";
export { AGENT_DOOR_KINDS } from "../../../packages/harness/src/target-post-run.ts";

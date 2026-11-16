/**
 * How the unattended agent writes its PR, by the ticket's repo (#345). A lab ticket's agent uses gh and git as
 * usual. A reviewed repo's agent writes only through the door (`npm run target:post`, #340), naming the repo with
 * `--repo`, which the door needs as soon as more than one repo is marked reviewed (Qodo on PR 346). The kinds it
 * may use come from `AGENT_DOOR_KINDS`, the list the door itself enforces during a run (`target-post-run.ts`, #347), so the prompt never
 * names a kind the hook refuses. Split from factory-agent.ts, which sits at the module size limit.
 */
import { AGENT_DOOR_KINDS, type AgentDoorKind } from "../door/target-post-run.ts";

/** What each allowed kind is for, and the options the agent passes. A kind added to the list needs a line here. */
const KIND_USE: Record<AgentDoorKind, [string, string]> = {
  push: ["push the branch", "--branch <name>"],
  "pr-create": ["open the PR", "--head <name> --title-file <f> --body-file <f>"],
  "pr-edit": ["change it", "--number <n> --body-file <f>"],
};

/** The instruction line on passing text as files and writing the PR. */
export function writeInstructions(runRoot: string, privateWorktree: boolean, github: string): string {
  if (privateWorktree)
    return "Pass PR bodies, comments and commit messages as files, never inline: write the text with the Write tool to a file in your run folder or the temp folder, then use gh pr create/edit --body-file or git commit -F. The policy hook reads the whole command, so a blocked word quoted in an inline message blocks it.";
  const uses = AGENT_DOOR_KINDS.map((kind) => {
    const [use, options] = KIND_USE[kind];
    return `${use} with npm run target:post -- ${kind} --repo ${github} ${options}`;
  });
  return [
    "Pass PR titles, bodies and commit messages as files, never inline: write the text with the Write tool to a file in your run folder or the temp folder, then use git commit -F.",
    `Every write to the reviewed repo ${github} goes through the door, run on its own from the lab's root under ${runRoot}:`,
    `${uses.slice(0, -1).join(", ")}, and ${uses.at(-1)}.`,
    `The door's other kinds are not yours: in a run the door takes only ${AGENT_DOOR_KINDS.join(", ")}, so you never comment on a PR, close one or write an issue there.`,
    "The guard refuses any other write to that repo (raw gh writes, git push); the door refuses text that gives anything away.",
  ].join(" ");
}

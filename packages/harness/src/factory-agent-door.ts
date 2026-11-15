/**
 * How the unattended agent writes its PR, by the ticket's repo (#345). A lab ticket's agent uses gh and git as
 * usual. A reviewed repo's agent writes only through the door (`npm run target:post`, #340), naming the repo with
 * `--repo`, which the door needs as soon as more than one repo is marked reviewed (Qodo on PR 346). Split from
 * factory-agent.ts, which sits at the module size limit.
 */

/** The instruction line on passing text as files and writing the PR. */
export function writeInstructions(runRoot: string, privateWorktree: boolean, github: string): string {
  if (privateWorktree)
    return "Pass PR bodies, comments and commit messages as files, never inline: write the text with the Write tool to a file in your run folder or the temp folder, then use gh pr create/edit --body-file or git commit -F. The policy hook reads the whole command, so a blocked word quoted in an inline message blocks it.";
  const door = `npm run target:post -- <kind> --repo ${github}`;
  return [
    "Pass PR titles, bodies and commit messages as files, never inline: write the text with the Write tool to a file in your run folder or the temp folder, then use git commit -F.",
    `Every write to the reviewed repo ${github} goes through the door, run on its own from the lab's root under ${runRoot}:`,
    `push with ${door.replace("<kind>", "push")} --branch <name>,`,
    `open the PR with ${door.replace("<kind>", "pr-create")} --head <name> --title-file <f> --body-file <f>,`,
    `and change it with ${door.replace("<kind>", "pr-edit")} --number <n> --body-file <f>.`,
    "The guard refuses any other write to that repo (raw gh writes, git push); the door refuses text that gives anything away.",
  ].join(" ");
}

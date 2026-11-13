/**
 * Owner gates the factory runner decides for itself, whatever the agent reports (#215).
 *
 * A pull request that changes the reviewer's own rules or configuration in a reviewed repository can't be
 * merged as ordinary work: Qodo reads those files as review rules, and results are only comparable under
 * a configuration version recorded in the decision log. So the runner, not the agent, says such a PR waits
 * for the owner.
 */

/** Files Qodo reads as rules or configuration: `AGENTS.md` and `INVARIANTS.md` anywhere, and Qodo's own config. */
const REVIEWER_RULE_FILE = /(^|\/)(AGENTS|INVARIANTS)\.md$|^\.pr_agent\.toml$|^\.qodo\//i;

/**
 * Why the PR waits for the owner, from GitHub's list of its changed files (`gh api --paginate --slurp
 * repos/<repo>/pulls/<n>/files`, an array of pages). Empty when it changes no reviewer rule file. A list
 * that can't be read is a gate too: not knowing is never read as "no rule file changed".
 */
export function reviewerRuleGates(pages: unknown): string[] {
  if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) {
    return [
      "the runner couldn't read the pull request's changed files, so it can't rule out a change to the reviewer's rules",
    ];
  }
  const files = (pages as unknown[][]).flat().map((f) => (f as { filename?: unknown } | null)?.filename);
  if (files.some((name) => typeof name !== "string")) {
    return [
      "the runner couldn't read every changed file's name, so it can't rule out a change to the reviewer's rules",
    ];
  }
  // A renamed file's old name is a change too, but GitHub lists it under the new name only in `filename`.
  const previous = (pages as unknown[][])
    .flat()
    .map((f) => (f as { previous_filename?: unknown }).previous_filename)
    .filter((name): name is string => typeof name === "string");
  const rules = [...new Set([...(files as string[]), ...previous].filter((name) => REVIEWER_RULE_FILE.test(name)))];
  return rules.length
    ? [
        `it changes the reviewer's rules (${rules.join(", ")}): the owner records a new configuration version before it merges`,
      ]
    : [];
}

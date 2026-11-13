/**
 * Owner gates the factory runner decides for itself, whatever the agent reports (#215).
 *
 * A pull request that changes the reviewer's own rules or configuration in a reviewed repository can't be
 * merged as ordinary work: Qodo reads those files as review rules, and results are only comparable under
 * a configuration version recorded in the decision log. So the runner, not the agent, says such a PR waits
 * for the owner.
 */

/** The most files GitHub's pull-request files endpoint returns, however many pages are asked for. */
export const MAX_LISTED_FILES = 3000;

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
  // GitHub's files endpoint stops at 3,000 files: a list that long may be cut off, so a rule file could be
  // past its end (Qodo on PR 220).
  if (files.length >= MAX_LISTED_FILES) {
    return [
      `the pull request lists ${MAX_LISTED_FILES} or more changed files, more than GitHub returns in full, so the runner can't rule out a change to the reviewer's rules`,
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
        // The names reach a ticket comment: only plain path characters survive, in code spans, so a file name
        // can't become a mention or a link (Qodo on PR 220).
        `it changes the reviewer's rules (${rules.map((r) => `\`${r.replace(/[^\w./-]/g, "?")}\``).join(", ")}): the owner records a new configuration version before it merges`,
      ]
    : [];
}

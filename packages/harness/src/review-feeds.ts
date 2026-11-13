/** The evidence `review:wait` saves besides Qodo's answer: the PR's comment feeds and its CI summary. */

/**
 * Saves one poll of the two comment feeds (each the raw `gh api --paginate --slurp` text: an array of
 * pages). The raw text is written first, every poll, so an answer that can't be parsed is still kept;
 * then a new version file is written when the content changed and Qodo has commented. Returns the
 * content to compare the next poll with. Throws when a feed doesn't parse, after the raw save.
 */
export function saveCommentFeeds(
  raw: { pr: string; inline: string },
  lastContent: string,
  write: (file: string, text: string) => void,
  short: string,
): string {
  write(`${short}.comments.latest.raw.json`, JSON.stringify(raw));
  // `user` is null on a comment whose author account was deleted: substituted with "unknown" rather
  // than read as Qodo's or crashing every poll (a GitHub app's comments outlive the human accounts
  // mentioned near them, not its own, but the shape allows for it and real feeds have shown nulls).
  // A comment that does have an author keeps its full user object, not just the login: only the
  // missing case is touched.
  type Comment = { user: { login: string } | null; updated_at: string };
  const pages = (text: string) => (JSON.parse(text) as Comment[][]).flat();
  const normalize = (list: Comment[]) => list.map((c) => (c.user ? c : { ...c, user: { login: "unknown" } }));
  const comments = { pr: normalize(pages(raw.pr)), inline: normalize(pages(raw.inline)) };
  const version = [...comments.pr, ...comments.inline]
    .filter((c) => (c.user?.login ?? "unknown").startsWith("qodo"))
    .map((c) => c.updated_at)
    .sort()
    .pop();
  // Compared by content: two edits in the same second share a timestamp but not their text.
  const content = JSON.stringify(comments);
  if (!version || content === lastContent) return lastContent;
  write(`${short}.comments.${version.replace(/:/g, "")}.raw.json`, content);
  return content;
}

/** One line per check run, or "no checks" when there are none. */
export function summarizeCi(checks: { name: string; status: string; conclusion: string | null }[]): string {
  return checks.map((c) => `${c.name}: ${c.conclusion ?? c.status}`).join(", ") || "no checks";
}

/**
 * CI is optional evidence, not Qodo's answer: a failed lookup must never keep the review record
 * from being written, so this never throws. `onError` is called (not thrown) so a caller can still
 * log why, before recording "unavailable".
 */
export function ciOrUnavailable(
  fetchChecks: () => { name: string; status: string; conclusion: string | null }[],
  onError?: (error: unknown) => void,
): string {
  try {
    return summarizeCi(fetchChecks());
  } catch (error) {
    onError?.(error);
    return "unavailable";
  }
}

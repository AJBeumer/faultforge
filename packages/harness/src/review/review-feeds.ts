/** The evidence `review:wait` saves besides Qodo's answer: the PR's comment feeds and its CI summary. */

/**
 * Saves one poll of the two comment feeds (raw `gh api --paginate --slurp` text). The raw text is written
 * first, so an answer that can't be parsed is still kept. Returns the content to compare the next poll with.
 */
export function saveCommentFeeds(
  raw: { pr: string; inline: string },
  lastContent: string,
  write: (file: string, text: string) => void,
  short: string,
): string {
  write(`${short}.comments.latest.raw.json`, JSON.stringify(raw));
  // `user` is null when the author's account was deleted. It reads as "unknown", so it is never taken
  // for Qodo's and never crashes a poll. A comment with an author is kept as it is.
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

export function summarizeCi(checks: { name: string; status: string; conclusion: string | null }[]): string {
  return checks.map((c) => `${c.name}: ${c.conclusion ?? c.status}`).join(", ") || "no checks";
}

/**
 * Never throws: CI is optional evidence, and a failed lookup must not keep the review record from being
 * written. `onError` lets a caller log why.
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

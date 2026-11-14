/**
 * The rules a template declaring benchmark version 2 must follow (#257; AUD-H3, AUD-H5, AUD-M7). A template
 * with no `benchmark`, or `benchmark: 1`, follows version 1 and nothing here applies to it, so no recorded
 * case or template changes.
 *
 * - A bug template's ticket criteria may not restate what the planted change breaks: none may contain one of
 *   its own kind terms or its invariant id. The ticket would hand the reviewer the oracle (AUD-H3).
 * - A criterion shared with other templates must appear in both a bug template and a control. One found only
 *   in controls, or only in bugs, tells the two apart by its wording alone (AUD-H5).
 * - The recorded line range is the lines the change actually touched (`changedLines`), not the whole replaced
 *   block (AUD-M7).
 */

export interface RuleTemplate {
  id: string;
  kind: "bug" | "control";
  benchmark?: number;
  invariantId?: string;
  match?: { kindTerms?: string[] };
  ticket?: { criteria?: string[] };
}

/** The benchmark version a template follows: 1 unless it declares another. */
export function benchmarkOf(template: { benchmark?: unknown }): number {
  return typeof template.benchmark === "number" ? template.benchmark : 1;
}

const normal = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Why a version-2 template breaks the version-2 rules, given every other template (any version), or an
 * empty list. A version-1 template always gets an empty list.
 */
export function benchmarkProblems(template: RuleTemplate, others: RuleTemplate[]): string[] {
  if (benchmarkOf(template) < 2) return [];
  const problems: string[] = [];
  const criteria = template.ticket?.criteria ?? [];
  if (template.kind === "bug") {
    const giveaways = [...(template.match?.kindTerms ?? []), ...(template.invariantId ? [template.invariantId] : [])];
    for (const [i, criterion] of criteria.entries()) {
      const named = giveaways.filter((term) => normal(criterion).includes(normal(term)));
      if (named.length) {
        problems.push(`ticket.criteria[${i}] restates what the change breaks (${named.join(", ")})`);
      }
    }
  }
  const rest = others.filter((o) => o.id !== template.id);
  for (const [i, criterion] of criteria.entries()) {
    const sharing = rest.filter((o) => (o.ticket?.criteria ?? []).some((c) => normal(c) === normal(criterion)));
    if (!sharing.length) continue;
    const kinds = new Set([template.kind, ...sharing.map((o) => o.kind)]);
    if (kinds.size === 1) {
      problems.push(
        `ticket.criteria[${i}] appears only in ${template.kind === "bug" ? "bug templates" : "controls"}, so its wording alone tells them apart`,
      );
    }
  }
  return problems;
}

/**
 * The lines a change touched in the new file, 1-based and inclusive: the lines between what the old and new
 * texts share at the top and at the bottom. A pure deletion touches no new line; its range is the one line
 * that now stands where the removed lines were (the last line of the file when they were at its end).
 */
export function changedLines(before: string, after: string): [number, number] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let top = 0;
  while (top < oldLines.length && top < newLines.length && oldLines[top] === newLines[top]) top++;
  let bottom = 0;
  while (
    bottom < oldLines.length - top &&
    bottom < newLines.length - top &&
    oldLines[oldLines.length - 1 - bottom] === newLines[newLines.length - 1 - bottom]
  ) {
    bottom++;
  }
  const first = top + 1;
  const last = newLines.length - bottom;
  if (last >= first) return [first, last];
  const at = Math.min(first, Math.max(newLines.length - (after.endsWith("\n") ? 1 : 0), 1));
  return [at, at];
}

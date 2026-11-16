/**
 * Reads the answer of Qodo's local review (`qodo review --json`) for a gate trial. Pure: text in, the
 * trial's own shape out.
 *
 * Open findings are gathered from every place the answer can hold them: its top-level list, and the
 * `introduced` and `still_open` lists of its `finding_state`, which may hold whole findings or only ids. A
 * finding counts as closed only when the answer lists it as resolved or dismissed and nowhere as open. An
 * open id with no finding behind it is kept, with no label, so the gate blocks on it.
 *
 * The answer also says whether its finding inventory is complete (`finding_state.complete`). It is passed
 * on, never guessed: on a first full review Qodo has no earlier checkpoint and reports it as incomplete.
 */
import type { TrialFinding, TrialReview } from "./gate-trial.ts";

/** How many times one round's review is asked for when the reviewer answers with an error. */
export const REVIEW_ATTEMPTS = 3;

/** The answer as JSON, without the `trace <hex>` line the CLI can end its output with; undefined if it isn't JSON. */
function parseAnswer(stdout: string): unknown {
  try {
    return JSON.parse(stdout.replace(/\r?\n\s*trace [0-9a-f]+\s*$/i, ""));
  } catch {
    return undefined;
  }
}

/**
 * True when the CLI's output is an error and not a review, or isn't JSON at all. Only then is the review
 * asked for again: a review that came back incomplete is a result, and stays one.
 */
export function isErrorAnswer(stdout: string): boolean {
  const payload = parseAnswer(stdout);
  return !payload || typeof payload !== "object" || Boolean((payload as { error?: unknown }).error);
}

/** One entry of a findings list as the trial's finding, or null when it has no id to follow it by. */
function findingOf(entry: unknown): TrialFinding | null {
  if (!entry || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string") return null;
  const f = entry as Record<string, unknown>;
  const at = (f.location ?? f.diff_reference ?? {}) as Record<string, unknown>;
  const lines =
    Number.isInteger(at.start_line) && Number.isInteger(at.end_line)
      ? ([at.start_line, at.end_line] as [number, number])
      : null;
  return {
    id: f.id as string,
    severity: typeof f.action_level === "string" ? f.action_level : null,
    title: typeof f.title === "string" ? f.title : null,
    category: typeof f.category === "string" ? f.category : null,
    file: typeof at.file_path === "string" ? at.file_path : null,
    lines,
    description: typeof f.description === "string" ? f.description : null,
  };
}

/** The ids in one `finding_state` list, whether it holds ids or whole findings; null when an entry is neither. */
function idsIn(list: unknown): string[] | null {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return null;
  const ids: string[] = [];
  for (const entry of list) {
    const id = typeof entry === "string" ? entry : (entry as { id?: unknown } | null)?.id;
    if (typeof id !== "string") return null;
    ids.push(id);
  }
  return ids;
}

/**
 * The answer as the loop reads it. `complete` only when the answer is a result, every finding and every
 * state list can be read, its coverage of the change was complete and no file was skipped.
 */
export function readLocalReview(stdout: string, evidence: string): TrialReview {
  const none: TrialReview = { complete: false, inventoryComplete: false, open: [], evidence };
  const payload = parseAnswer(stdout) as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object" || payload.error || !Array.isArray(payload.findings)) return none;
  const state = (payload.finding_state ?? {}) as Record<string, unknown>;
  const introduced = idsIn(state.introduced);
  const stillOpen = idsIn(state.still_open);
  const resolved = idsIn(state.resolved);
  const dismissed = idsIn(state.dismissed);
  if (!introduced || !stillOpen || !resolved || !dismissed) return none;

  // Every finding the answer holds anywhere, by id: the top-level list first.
  const known = new Map<string, TrialFinding>();
  for (const entry of payload.findings as unknown[]) {
    const finding = findingOf(entry);
    if (!finding) return none;
    known.set(finding.id, finding);
  }
  for (const list of [state.introduced, state.still_open]) {
    for (const entry of (list as unknown[] | undefined) ?? []) {
      const finding = findingOf(entry);
      if (finding && !known.has(finding.id)) known.set(finding.id, finding);
    }
  }
  // Said to be open somewhere: that wins over a resolved or dismissed entry for the same id.
  const saidOpen = new Set([...introduced, ...stillOpen]);
  const closed = new Set([...resolved, ...dismissed].filter((id) => !saidOpen.has(id)));
  const open: TrialFinding[] = [...known.values()].filter((f) => !closed.has(f.id));
  // An id listed as open with no finding behind it: kept without a label, which the gate blocks on.
  for (const id of saidOpen) {
    if (!known.has(id))
      open.push({ id, severity: null, title: "A finding the review lists as open without its details" });
  }
  const meta = (payload.meta ?? {}) as { coverage?: { complete?: unknown }; skipped_files?: unknown };
  const skipped = Array.isArray(meta.skipped_files) ? meta.skipped_files.length : 0;
  return {
    complete: meta.coverage?.complete === true && skipped === 0,
    inventoryComplete: state.complete === true,
    open,
    evidence,
  };
}

/**
 * Labels Qodo's local-review findings from the review's own `finding_state`, never from whether a finding
 * repeats one from an earlier, unrelated run.
 *
 * Each `finding_state` list holds full finding objects, not plain ids, unlike a pull request review.
 */
export interface RawFinding {
  id: string;
  title?: string | null;
  description?: string | null;
  category?: string | null;
  action_level?: string | null;
  diff_reference?: { file_path?: string | null; start_line?: number | null; end_line?: number | null } | null;
}

export interface FindingState {
  complete?: boolean;
  introduced?: RawFinding[];
  resolved?: RawFinding[];
  still_open?: RawFinding[];
  dismissed?: RawFinding[];
}

export interface LocalReviewPayload {
  findings?: RawFinding[];
  finding_state?: FindingState;
  meta?: {
    coverage?: { complete?: boolean };
    run?: { effort?: { effective?: string | null; requested?: string | null } };
    local_review_ids?: Record<string, string>;
  };
}

export interface LocalFinding {
  id: string;
  file: string | null;
  lines: [number, number] | null;
  severity: string | null;
  category: string | null;
  title: string | null;
  description: string | null;
  /** "carried over" includes resolved and dismissed findings: still worth seeing, not acted on again. */
  label: "new" | "carried over";
  /** Not listed in `finding_state.resolved` or `dismissed`: a finding no list names counts as open. */
  open: boolean;
}

function idsOf(list: RawFinding[] | undefined): Set<string> {
  return new Set((list ?? []).map((f) => f.id));
}

/** False when a `finding_state` entry isn't a finding with a string id: then the labels can't be trusted. */
export function stateListsReadable(payload: LocalReviewPayload): boolean {
  const state = payload.finding_state ?? {};
  return [state.introduced, state.still_open, state.resolved, state.dismissed].every(
    (list) =>
      list === undefined ||
      (Array.isArray(list) &&
        list.every((f) => typeof f === "object" && f !== null && typeof (f as { id?: unknown }).id === "string")),
  );
}

export function labelFindings(payload: LocalReviewPayload): LocalFinding[] {
  const state = payload.finding_state ?? {};
  const introduced = idsOf(state.introduced);
  const stillOpen = idsOf(state.still_open);
  const closed = new Set([...idsOf(state.resolved), ...idsOf(state.dismissed)]);
  // The top-level list first, then any open finding only `finding_state` carries: a complete result
  // that names an open action-required finding there must never read as clean.
  const all = new Map<string, RawFinding>();
  for (const f of payload.findings ?? []) all.set(f.id, f);
  for (const f of [...(state.introduced ?? []), ...(state.still_open ?? [])]) if (!all.has(f.id)) all.set(f.id, f);
  return [...all.values()].map((f) => {
    const ref = f.diff_reference;
    const lines =
      ref?.start_line != null && ref?.end_line != null ? ([ref.start_line, ref.end_line] as [number, number]) : null;
    return {
      id: f.id,
      file: ref?.file_path ?? null,
      lines,
      severity: f.action_level ?? null,
      category: f.category ?? null,
      title: f.title ?? null,
      description: f.description ?? null,
      label: introduced.has(f.id) ? "new" : "carried over",
      // A finding no list names is not closed, and one listed both open and closed counts as open:
      // the reading that can't hide a blocker.
      open: introduced.has(f.id) || stillOpen.has(f.id) || !closed.has(f.id),
    };
  });
}

export function formatFinding(f: LocalFinding): string {
  const where = f.file ? `${f.file}${f.lines ? `:${f.lines[0]}-${f.lines[1]}` : ""}` : "(no location)";
  const openNote = f.open ? "" : ", closed";
  return `- [${f.severity ?? "?"}] ${f.title ?? "(no title)"} (${f.category ?? "?"}, ${where}) — ${f.label}${openNote}`;
}

/**
 * The overlay checks behind `case:build`: which fields a case's overlay may set (a narrow allow-list, with
 * extras only a legacy case may use), and which ones it actually sets, for the command to print.
 */

const OVERLAY_TOP_LEVEL = ["detection", "collateral", "otherReviewers", "challenge", "review", "notes"];
/** Only a case whose review predates `review:wait` (no saved review file) may use these. */
const LEGACY_ONLY_TOP_LEVEL = ["findings", "legacyFindingsPath"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Problems with an overlay's shape: any field outside the documented, narrow allow-list, or (unless
 * `isLegacy`) any of the extras reserved for a case with no saved review file. Never throws on a
 * malformed shape (an overlay isn't trusted input) — an unexpected type is reported as a problem.
 */
export function overlayProblems(raw: Record<string, unknown>, isLegacy = false): string[] {
  const problems: string[] = [];
  const allowed = isLegacy ? [...OVERLAY_TOP_LEVEL, ...LEGACY_ONLY_TOP_LEVEL] : OVERLAY_TOP_LEVEL;
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      problems.push(
        LEGACY_ONLY_TOP_LEVEL.includes(key)
          ? `overlay sets ${key}, which only a legacy case (one whose review predates review:wait) may use`
          : `overlay sets ${key}, which is not allowed`,
      );
    }
  }
  if (raw.detection !== undefined && !isPlainObject(raw.detection)) {
    problems.push("overlay sets detection, which must be an object");
  } else if (isPlainObject(raw.detection)) {
    const allowedDetection = isLegacy ? ["notes", "matchDetailOverrides"] : ["notes"];
    for (const key of Object.keys(raw.detection)) {
      if (!allowedDetection.includes(key)) problems.push(`overlay sets detection.${key}, which is not allowed`);
    }
  }
  if (raw.review !== undefined && !isPlainObject(raw.review)) {
    problems.push("overlay sets review, which must be an object");
  } else if (isPlainObject(raw.review)) {
    for (const key of Object.keys(raw.review)) {
      if (key !== "linkedRepositories") problems.push(`overlay sets review.${key}, which is not allowed`);
    }
  }
  if (raw.notes !== undefined && (!Array.isArray(raw.notes) || raw.notes.some((n) => typeof n !== "string"))) {
    problems.push("overlay sets notes, which must be a list of strings");
  }
  if (raw.findings !== undefined && isLegacy) {
    if (!Array.isArray(raw.findings)) {
      problems.push("overlay sets findings, which must be an array");
    } else {
      for (const f of raw.findings) {
        if (!isPlainObject(f)) {
          problems.push("overlay sets a findings[] entry that isn't an object");
          continue;
        }
        for (const key of Object.keys(f)) {
          if (!["id", "severity", "commentLines", "summary"].includes(key)) {
            problems.push(`overlay sets findings[].${key}, which is not allowed`);
          }
        }
      }
    }
  }
  return problems;
}

/** Dotted paths of the fields this overlay actually sets, for the command to print. */
export function overlayFieldsTaken(raw: Record<string, unknown>): string[] {
  const taken: string[] = [];
  const detection = isPlainObject(raw.detection) ? raw.detection : undefined;
  if (detection?.notes) taken.push("detection.notes");
  if (detection?.matchDetailOverrides) taken.push("detection.matchDetailOverrides");
  if (raw.notes) taken.push("notes");
  if (raw.collateral) taken.push("collateral");
  if (raw.otherReviewers) taken.push("otherReviewers");
  if (raw.challenge) taken.push("challenge");
  const review = isPlainObject(raw.review) ? raw.review : undefined;
  if (review?.linkedRepositories) taken.push("review.linkedRepositories");
  if (raw.findings) taken.push("findings (severity/commentLines/summary overrides)");
  if (raw.legacyFindingsPath) taken.push("legacyFindingsPath");
  return taken;
}

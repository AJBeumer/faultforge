/** The printer `case:build` writes published records with, so a regenerated record keeps its bytes. */

const LINE_WIDTH = 120;

function isPrimitive(v: unknown): boolean {
  return v === null || typeof v !== "object";
}

/** A `{ pass, detail }` match criterion: the one object shape this printer tries to keep on one line. */
function isCriterion(v: unknown): v is { pass: boolean; detail: string } {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v as object);
  return keys.length === 2 && keys.includes("pass") && keys.includes("detail");
}

/**
 * Renders JSON the way this repo's published records are written: two-space indent, an array of
 * scalars or a `{ pass, detail }` criterion stay on one line when that fits `LINE_WIDTH`, everything
 * else (objects, and arrays of objects) is one line per property so a diff stays readable.
 */
export function printRecord(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const childPad = "  ".repeat(indent + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every(isPrimitive)) {
      const inline = `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
      if (pad.length + inline.length <= LINE_WIDTH) return inline;
    }
    const items = value.map((v) => `${childPad}${printRecord(v, indent + 1)}`).join(",\n");
    return `[\n${items}\n${pad}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    if (isCriterion(value)) {
      const inline = `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;
      if (pad.length + inline.length <= LINE_WIDTH) return inline;
    }
    const lines = entries.map(([k, v]) => `${childPad}${JSON.stringify(k)}: ${printRecord(v, indent + 1)}`);
    return `{\n${lines.join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(value);
}

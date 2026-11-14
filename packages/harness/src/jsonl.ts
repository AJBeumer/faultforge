/**
 * JSON Lines, read in one place (AUD-N1): one JSON value per line, blank lines skipped. The answer key, the
 * audit log and the factory's run logs are all this format. A line that isn't JSON throws, naming its number,
 * so a damaged file is never read as a shorter one.
 */
import { readFileSync } from "node:fs";

/** Every value in `text`, in order. */
export function parseJsonLines<T = Record<string, unknown>>(text: string): T[] {
  const values: T[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch (error) {
      throw new Error(`line ${index + 1} is not JSON: ${(error as Error).message}`);
    }
  }
  return values;
}

/** Every value in the file at `path`. Throws when the file can't be read. */
export function readJsonLines<T = Record<string, unknown>>(path: string): T[] {
  return parseJsonLines<T>(readFileSync(path, "utf8"));
}

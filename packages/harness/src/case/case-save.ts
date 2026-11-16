/**
 * `case:build --save`: writes a case's record to `private/cases/<caseId>.json`, then reminds the owner to run
 * `npm run ledger:anchor`. A saved case is when the answer key and audit log last grew, so that anchor is worth having.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What `--save` prints last, once the record is in place. */
export const ANCHOR_REMINDER =
  "[case:build] next: commit and push private storage, then run `npm run ledger:anchor` and commit " +
  "docs/ledger-anchors.txt here through a PR, so this case's history is anchored in public";

/**
 * Saves `text` as `<casesDir>/<caseId>.json`, created exclusively, so of two builds racing for an absent file
 * only one writes. The same content already there is fine; other content is refused, never replaced.
 * Returns 0, or 2 when refused. Progress goes to `error` (stderr), so stdout holds only the record.
 */
export function saveCaseRecord(casesDir: string, caseId: string, text: string, error: (line: string) => void): 0 | 2 {
  const savePath = join(casesDir, `${caseId}.json`);
  mkdirSync(casesDir, { recursive: true });
  try {
    writeFileSync(savePath, text, { flag: "wx" });
    error(`[case:build] saved ${savePath}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (readFileSync(savePath, "utf8") !== text) {
      error(`case:build: ${savePath} already holds a different record; compare them, nothing saved`);
      return 2;
    }
    error(`[case:build] ${savePath} already holds this record`);
  }
  error(ANCHOR_REMINDER);
  return 0;
}

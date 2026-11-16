/**
 * `case:build --save`: writes a case's record to `private/cases/<caseId>.json` (AUD-M24), and ends by
 * reminding the owner to anchor the private history in this repository (`npm run ledger:anchor`, AUD-M11):
 * a saved case is the moment the answer key and audit log last grew, so it is the anchor worth having.
 * Split from `case-build.ts`, which is at the module size limit.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What `--save` prints last, once the record is in place. */
export const ANCHOR_REMINDER =
  "[case:build] next: commit and push private storage, then run `npm run ledger:anchor` and commit " +
  "docs/ledger-anchors.txt here through a PR, so this case's history is anchored in public";

/**
 * Saves `text` as `<casesDir>/<caseId>.json`, created exclusively, so of two builds racing for an absent file
 * only one writes (Qodo on PR 264). The same content already there is fine; other content is refused, never
 * replaced. Returns 0, or 2 when refused. Progress goes to `error` (stderr): stdout holds only the record.
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

/**
 * Test fixture: a fresh temp folder, named by its real spelling.
 *
 * On Windows the system's temp folder can be an 8.3 short name (`RUNNER~1`). `mkdtempSync` keeps that
 * spelling, while git and Node's own lookups write the folder out in full, so a test that compares the two
 * as text passes on one machine and fails on another. A path from here is already the one the operating
 * system itself gives (`realpathSync.native`, which expands a short name; plain `realpathSync` does not), so
 * it compares equal to what git reports.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A new, empty folder under the system's temp folder, whose name starts with `prefix`. */
export function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

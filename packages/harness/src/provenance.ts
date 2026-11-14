/**
 * What every record and audit event says about how it was made, in one place (AUD-N1): the tool's name and
 * version, and the content hash used for `inputHash`, proof-test pins and published records.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.ts";

/** `faultforge-harness@<version from package.json>`. */
export const TOOL = `faultforge-harness@${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version}`;

/** The SHA-256 of `data`, as lower-case hex. */
export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

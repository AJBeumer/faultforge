/**
 * The harness's own source files, for the tests that read them as text (the door, the one writer, the shared
 * helpers, gh calls, drive spellings). The modules sit in area folders, so a test finds a module here by its
 * file name, wherever its area is.
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

/** `packages/harness/src`. */
export const SRC = join(import.meta.dirname, "..");

/** Every module under `SRC`, tests left out, as paths relative to it with `/`. */
export function sourceFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
}

/** The full path of the module named `name` (`case-pr.ts`), in whichever area folder it sits. */
export function sourcePath(name: string): string {
  const found = sourceFiles().find((f) => basename(f) === name);
  if (!found) throw new Error(`no module named ${name} under ${SRC}`);
  return join(SRC, found);
}

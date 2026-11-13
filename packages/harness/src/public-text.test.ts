/**
 * Public text holds no local paths, user names or Qodo trace ids (#230, audit N-15): the docs and their
 * evidence are permanent public history, and a raw tool output pasted into them carries the machine it ran on.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./paths.ts";

const TEXT = /\.(md|txt|json|jsonl|csv|yml|yaml)$/i;
const LOCAL = [
  { what: "a Windows user folder", pattern: /[A-Za-z]:[\\/]Users[\\/]/ },
  { what: "a local project path", pattern: /[A-Za-z]:[\\/]Projects[\\/]/ },
  { what: "a Qodo trace id", pattern: /\btrace [0-9a-f]{32}\b/ },
  {
    what: "a Qodo operation id",
    pattern: /\boperation [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
  },
];

function publicText(): { path: string; text: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : TEXT.test(name) ? [full] : [];
    });
  return [join(ROOT, "README.md"), ...walk(join(ROOT, "docs"))].map((file) => ({
    path: relative(ROOT, file).replace(/\\/g, "/"),
    text: readFileSync(file, "utf8"),
  }));
}

describe("public text holds nothing of the machine it was made on (audit N-15)", () => {
  it("has no local path, user folder, or Qodo trace or operation id", () => {
    const found = publicText().flatMap(({ path, text }) =>
      LOCAL.filter(({ pattern }) => pattern.test(text)).map(({ what }) => `${path}: ${what}`),
    );
    expect(found).toEqual([]);
  });
});

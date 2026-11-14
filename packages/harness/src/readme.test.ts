/**
 * Statements in the README that the code decides, checked so they can't go stale again (AUD-N4).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { engines: { node: string } };

describe("README", () => {
  it("names the Node.js version package.json requires", () => {
    const required = pkg.engines.node.match(/^>=(\d+(?:\.\d+)*)$/)?.[1];
    expect(required).toBeDefined();
    expect(readme).toContain(`Requires Node.js ${required} or later.`);
  });
});

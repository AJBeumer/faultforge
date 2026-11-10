import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import config from "./vitest.config.ts";

describe("vitest.config: temp directory isolation (#110)", () => {
  it("points TMPDIR/TMP/TEMP at a scratch directory of its own, not the machine-wide one", () => {
    const env = config.test?.env;
    expect(env?.TMPDIR).toBeTruthy();
    expect(env?.TMPDIR).toBe(env?.TMP);
    expect(env?.TMPDIR).toBe(env?.TEMP);
    expect(env?.TMPDIR).not.toBe(tmpdir());
    expect(existsSync(String(env?.TMPDIR))).toBe(true);
  });
});

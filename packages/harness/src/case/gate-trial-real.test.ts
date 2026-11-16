import { describe, expect, it } from "vitest";
import { isPlainArgument, NO_PUSH } from "./gate-trial-real.ts";

describe("the trial's own commands", () => {
  it("calls only plain text a safe command-line argument", () => {
    for (const arg of ["ci", "--ignore-scripts", "test/not-so.test.ts", "vitest", "a=b", "@scope/pkg", "C:/x"]) {
      expect(isPlainArgument(arg)).toBe(true);
    }
    for (const arg of ["", "a b", "a&b", "a;b", "$(x)", "a|b", "a>b", '"a"', "a\nb", "%PATH%", "a^b"]) {
      expect(isPlainArgument(arg)).toBe(false);
    }
  });

  it("uses a push address no host answers", () => {
    expect(NO_PUSH).toMatch(/^no-push:/);
  });
});

import { describe, expect, it } from "vitest";
import { GROWTH_FACTOR, growth, LINEAR_BOUND } from "./fixtures.ts";

describe("growth tells linear code from quadratic code without a wall clock", () => {
  let sink = 0;
  const linear = (scale: number) => {
    for (let i = 0; i < 200_000 * scale; i++) sink += i & 7;
  };
  const quadratic = (scale: number) => {
    const n = 400 * scale;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) sink += (i ^ j) & 7;
  };

  it("passes linear code and fails quadratic code", () => {
    expect(growth(linear)).toBeLessThan(LINEAR_BOUND);
    expect(growth(quadratic)).toBeGreaterThan(LINEAR_BOUND);
    expect(sink).toBeGreaterThan(0);
  });

  it("puts the bound between linear and quadratic growth", () => {
    expect(LINEAR_BOUND).toBeGreaterThan(GROWTH_FACTOR);
    expect(LINEAR_BOUND).toBeLessThan(GROWTH_FACTOR ** 2);
  });
});

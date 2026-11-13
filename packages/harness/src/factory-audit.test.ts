import { describe, expect, it } from "vitest";
import { pullsSince } from "./factory-audit.ts";

describe("pullsSince: the audit's PR list, every page in the window, never the whole history (#114)", () => {
  it("reads past the first page when the window holds more pulls than fit on one", () => {
    const pages = [
      Array.from({ length: 2 }, (_, i) => ({ number: 100 - i, updated_at: "2026-11-09T12:00:00Z" })),
      [{ number: 97, updated_at: "2026-11-09T11:00:00Z" }],
      [],
    ];
    const calls: number[] = [];
    const fetch = (page: number) => {
      calls.push(page);
      return pages[page - 1] ?? [];
    };
    const result = pullsSince(Date.parse("2026-11-09T10:00:00Z"), fetch);
    expect(result.map((p) => p.number)).toEqual([100, 99, 97]);
    expect(calls).toEqual([1, 2, 3]);
  });

  it("stops at the first pull older than the cutoff, without reading a page past it", () => {
    const pages = [
      [
        { number: 5, updated_at: "2026-11-09T12:00:00Z" },
        { number: 4, updated_at: "2026-11-01T00:00:00Z" },
      ],
      [{ number: 3, updated_at: "2026-10-01T00:00:00Z" }],
    ];
    const calls: number[] = [];
    const fetch = (page: number) => {
      calls.push(page);
      return pages[page - 1] ?? [];
    };
    const result = pullsSince(Date.parse("2026-11-09T00:00:00Z"), fetch);
    expect(result.map((p) => p.number)).toEqual([5]);
    expect(calls).toEqual([1]);
  });

  it("returns nothing, and makes one call, when the newest pull is already outside the window", () => {
    const fetch = (page: number) => (page === 1 ? [{ number: 1, updated_at: "2026-01-01T00:00:00Z" }] : []);
    expect(pullsSince(Date.parse("2026-11-09T00:00:00Z"), fetch)).toEqual([]);
  });
});

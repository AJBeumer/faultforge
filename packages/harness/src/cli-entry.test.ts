import { describe, expect, it } from "vitest";
import { runEntry } from "./cli-entry.ts";

describe("runEntry's failure paths (AUD-N3, Qodo on PR 277)", () => {
  const run = async (main: (argv: string[]) => number | Promise<number>) => {
    const said: string[] = [];
    const code = await runEntry(
      "factory:tick",
      async () => main,
      ["a"],
      3,
      (line) => said.push(line),
    );
    return { code, said };
  };

  it("turns a synchronous throw in main into the could-not-run code, naming the script and the stack", async () => {
    const { code, said } = await run(() => {
      throw new Error("boom in main");
    });
    expect(code).toBe(3);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^factory:tick stopped on an unexpected error: Error: boom in main/);
    expect(said[0]).toContain("cli-entry.test.ts");
  });

  it("turns a rejection from an async main into the could-not-run code", async () => {
    const { code, said } = await run(async () => {
      await Promise.resolve();
      throw new Error("late");
    });
    expect(code).toBe(3);
    expect(said[0]).toContain("factory:tick stopped on an unexpected error: Error: late");
  });

  it("names a thrown value that isn't an Error", async () => {
    const { code, said } = await run(() => Promise.reject("plain"));
    expect(code).toBe(3);
    expect(said).toEqual(["factory:tick stopped on an unexpected error: plain"]);
  });

  it("hands main its arguments and returns its code untouched, 1 included", async () => {
    let seen: string[] = [];
    const { code, said } = await run((argv) => {
      seen = argv;
      return 1;
    });
    expect([code, seen, said]).toEqual([1, ["a"], []]);
  });
});

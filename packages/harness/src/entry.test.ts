import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { COULD_NOT_RUN, couldNotRunCode, failureText, runEntry, uncaughtHandler } from "./entry.ts";

const url = (name: string) => pathToFileURL(join(import.meta.dirname, name)).href;

describe("runEntry (AUD-N3)", () => {
  const before = process.exitCode;
  afterEach(() => {
    process.exitCode = before;
  });

  it("makes a number main returns the exit code, sync or async", async () => {
    await runEntry(url("docs-check.ts"), () => 1);
    expect(process.exitCode).toBe(1);
    await runEntry(url("docs-check.ts"), async () => 0);
    expect(process.exitCode).toBe(0);
  });

  it("leaves the exit code alone when main returns nothing", async () => {
    process.exitCode = undefined;
    await runEntry(url("factory-timeline.ts"), () => undefined);
    expect(process.exitCode).toBeUndefined();
  });

  it("turns a thrown error into the could-not-run code, with the script's name and the stack", async () => {
    const said: string[] = [];
    await runEntry(
      url("factory-tick.ts"),
      () => {
        throw new Error("boom in main");
      },
      (text) => said.push(text),
    );
    expect(process.exitCode).toBe(3);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^factory-tick\.ts could not run: Error: boom in main/);
    expect(said[0]).toContain("entry.test.ts");
  });

  it("turns a rejected promise into the could-not-run code", async () => {
    const said: string[] = [];
    await runEntry(
      url("ticket-ready.ts"),
      () => Promise.reject(new Error("late")),
      (text) => said.push(text),
    );
    expect(process.exitCode).toBe(2);
    expect(said[0]).toContain("ticket-ready.ts could not run: Error: late");
  });

  it("refuses a script that has no could-not-run code", async () => {
    await expect(runEntry(url("no-such-script.ts"), () => 0)).rejects.toThrow(/no could-not-run code/);
  });
});

describe("the uncaught-error handler", () => {
  it("prints the failure and exits with the script's code", () => {
    const written: string[] = [];
    const exits: number[] = [];
    uncaughtHandler(
      "guard-install.ts",
      2,
      (c) => exits.push(c),
      (t) => written.push(t),
    )(new Error("escaped"));
    expect(exits).toEqual([2]);
    expect(written[0]).toMatch(/^guard-install\.ts could not run: Error: escaped/);
  });

  it("still exits when printing fails", () => {
    const exits: number[] = [];
    const handler = uncaughtHandler(
      "guard-install.ts",
      2,
      (c) => exits.push(c),
      () => {
        throw new Error("stderr closed");
      },
    );
    expect(() => handler("x")).toThrow("stderr closed");
    expect(exits).toEqual([2]);
  });
});

describe("couldNotRunCode", () => {
  it("finds a guarded script by path or file URL, and nothing else", () => {
    expect(couldNotRunCode(join(import.meta.dirname, "factory-tick.ts"))).toBe(3);
    expect(couldNotRunCode(url("docs-check.ts"))).toBe(2);
    expect(couldNotRunCode(join(import.meta.dirname, "vitest.mjs"))).toBeUndefined();
    expect(couldNotRunCode("toString")).toBeUndefined();
    expect(couldNotRunCode(undefined)).toBeUndefined();
  });

  it("never uses 1, which the guarded scripts give another meaning", () => {
    expect(Object.values(COULD_NOT_RUN).filter((c) => c === 0 || c === 1)).toEqual([]);
  });

  it("names a non-Error failure too", () => {
    expect(failureText(join("a", "b", "x.ts"), "plain")).toBe("x.ts could not run: plain");
  });
});

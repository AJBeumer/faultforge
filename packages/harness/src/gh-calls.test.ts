import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `gh repos/o/r/pulls` is not a command: `gh` prints its help text and exits non-zero. The REST endpoints
 * go through `gh api <path>`, and a refactor once dropped the `api` at one call site (#168). That call runs
 * only after an agent finishes, and no unit test reached it with real arguments, so this test reads the
 * sources instead: a REST path written as a string as the first argument of `gh(...)` or `ghJson(...)` fails
 * the build. That is the form that failed. A path held in a variable, or a call in a file outside this folder,
 * is not caught: `ghApiJson` is the way to call an endpoint, and this test only backs that rule up.
 */
const SRC = dirname(fileURLToPath(import.meta.url));

// gh( or ghJson( or ghJson<T>(, then a string whose text starts like a REST path.
const REST_PATH_FIRST = /\bgh(?:Json)?(?:<[^()]*?>)?\(\s*[`"'](?:repos\/|orgs\/|user\b)/g;

/** Every `file:line` where a REST path is the first argument of gh or ghJson. */
function restPathCalls(file: string, text: string): string[] {
  return [...text.matchAll(REST_PATH_FIRST)].map((m) => `${file}:${text.slice(0, m.index).split("\n").length}`);
}

describe("restPathCalls", () => {
  it("finds a REST path passed straight to gh or ghJson, with and without a type argument", () => {
    expect(restPathCalls("a.ts", 'gh("repos/o/r")')).toEqual(["a.ts:1"]);
    expect(restPathCalls("a.ts", "x\nghJson<Pull[]>(`repos/o/r/pulls?page=1`)")).toEqual(["a.ts:2"]);
    expect(restPathCalls("a.ts", 'gh(\n  "orgs/o")')).toEqual(["a.ts:1"]);
    expect(restPathCalls("a.ts", `gh('user')`)).toEqual(["a.ts:1"]);
  });

  it("leaves the calls that are correct", () => {
    expect(restPathCalls("a.ts", 'gh("api", "repos/o/r")')).toEqual([]);
    expect(restPathCalls("a.ts", 'gh("pr", "view", "9")')).toEqual([]);
    expect(restPathCalls("a.ts", 'ghAll("repos/o/r/issues")')).toEqual([]);
    expect(restPathCalls("a.ts", 'ghJson<X>("pr", "view")')).toEqual([]);
  });
});

describe("the harness sources", () => {
  it("never pass a REST path to gh without api", () => {
    const files = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(10);
    const found = files.flatMap((f) => restPathCalls(f, readFileSync(join(SRC, f), "utf8")));
    expect(found).toEqual([]);
  });
});

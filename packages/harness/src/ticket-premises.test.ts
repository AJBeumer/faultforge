import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { classify, exportedNames, premiseProblems, premisesOf, proseOf, scriptNames } from "./ticket-premises.ts";

const DELIVERABLES = ["Result", "Done when"];

/** A checkout with one script, one source file with two exports, one doc and a private folder. */
let checkout: string;
beforeAll(() => {
  checkout = mkdtempSync(join(tmpdir(), "premises-"));
  mkdirSync(join(checkout, "src"), { recursive: true });
  mkdirSync(join(checkout, "docs"), { recursive: true });
  mkdirSync(join(checkout, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(checkout, "private"), { recursive: true });
  writeFileSync(
    join(checkout, "package.json"),
    JSON.stringify({ scripts: { check: "vitest", "ticket:ready": "tsx x" } }),
  );
  writeFileSync(
    join(checkout, "src", "helpers.ts"),
    "export function privateDir() {}\nexport const loadFactory = () => 1;\nfunction hidden() {}\n",
  );
  writeFileSync(join(checkout, "node_modules", "dep", "index.js"), "export function fromDependency() {}\n");
  writeFileSync(join(checkout, "docs", "guide.md"), "# guide\n");
  writeFileSync(join(checkout, "private", "secret.json"), "{}");
});

const ticket = (notes: string, done = "- [ ] New `src/report.ts` prints it") => `### Result
A thing that reads \`src/helpers.ts\`.

### Done when
${done}

### Must not break
- \`npm run check\` stays green

### Notes
${notes}`;

describe("premisesOf", () => {
  it("finds a path, a script and a function named as existing things", () => {
    const body = ticket("Reuse `privateDir()` from `src/helpers.ts`; `ticket:ready` reads the list.");
    expect(premisesOf(body, DELIVERABLES)).toEqual([
      { token: "check", kind: "script" },
      { token: "privateDir", kind: "function" },
      { token: "src/helpers.ts", kind: "path" },
      { token: "ticket:ready", kind: "script" },
    ]);
  });

  it("skips the deliverable sections, where new things are named", () => {
    const body = ticket("Nothing assumed.", "- [ ] `src/report.ts` exists and `report()` runs");
    expect(premisesOf(body, DELIVERABLES)).toEqual([{ token: "check", kind: "script" }]);
  });

  it("skips a token the sentence introduces as new", () => {
    const body = ticket("Add a new `src/report.ts` beside `src/helpers.ts`; it gains `report()`.");
    expect(premisesOf(body, DELIVERABLES)).toEqual([
      { token: "check", kind: "script" },
      { token: "src/helpers.ts", kind: "path" },
    ]);
  });

  it("ignores tokens inside code blocks and details blocks", () => {
    const body = ticket(
      "Assumes `src/helpers.ts`.\n\n```\nsee `src/gone.ts`\n```\n\n<details>\n<summary>Original</summary>\nused `old:script`\n</details>",
    );
    expect(premisesOf(body, DELIVERABLES).map((p) => p.token)).toEqual(["check", "src/helpers.ts"]);
  });

  it("skips private paths, URLs, placeholders and directories", () => {
    const body = ticket(
      "Snapshot in `private/config/qodo-v6/rules.json`; see `https://example.org/a.md`, `raw-artifacts/<ts>/x.json`, `packages/harness/src/`.",
    );
    expect(premisesOf(body, DELIVERABLES).map((p) => p.token)).toEqual(["check"]);
  });

  it("strips a line reference from a path", () => {
    expect(classify("packages/harness/src/inject.ts:68")).toEqual({
      token: "packages/harness/src/inject.ts",
      kind: "path",
    });
    expect(classify("src/a.ts:10-12")).toEqual({ token: "src/a.ts", kind: "path" });
  });

  it("reads the script name out of npm run", () => {
    expect(classify("npm run qodo:check")).toEqual({ token: "qodo:check", kind: "script" });
    expect(classify("npm run -s check")).toEqual({ token: "check", kind: "script" });
  });

  it("names each premise once", () => {
    const body = ticket("`src/helpers.ts` twice: `src/helpers.ts`.");
    expect(premisesOf(body, DELIVERABLES).filter((p) => p.kind === "path")).toHaveLength(1);
  });

  it("leaves prose, commands with spaces and plain words alone", () => {
    for (const token of ["git -C private", "main", "FAULTFORGE_PRIVATE_DIR", "Done when", "x = 1"]) {
      expect(classify(token)).toBeNull();
    }
  });
});

describe("premiseProblems", () => {
  it("reports nothing when every premise holds", () => {
    const body = ticket("Reuse `privateDir()` and `loadFactory()` from `src/helpers.ts`; `docs/guide.md` explains it.");
    expect(premiseProblems(premisesOf(body, DELIVERABLES), checkout)).toEqual([]);
  });

  it("reports a missing file", () => {
    const body = ticket("Extend the existing `src/vitest.config.test.ts`.");
    expect(premiseProblems(premisesOf(body, DELIVERABLES), checkout)).toEqual([
      "stale premise: src/vitest.config.test.ts (path) not found",
    ]);
  });

  it("reports a missing script", () => {
    const body = ticket("`qodo:check` runs first; `npm run mutation:check` after.");
    expect(premiseProblems(premisesOf(body, DELIVERABLES), checkout)).toEqual([
      "stale premise: qodo:check (script) not found",
      "stale premise: mutation:check (script) not found",
    ]);
  });

  it("reports a missing function, and does not count exports under node_modules or non-exported ones", () => {
    const body = ticket("Copy `resolvePrivate()`; `fromDependency()` and `hidden()` are elsewhere.");
    expect(premiseProblems(premisesOf(body, DELIVERABLES), checkout)).toEqual([
      "stale premise: resolvePrivate (function) not found",
      "stale premise: fromDependency (function) not found",
      "stale premise: hidden (function) not found",
    ]);
  });

  it("reports every stale premise at once, in the ticket's order", () => {
    const body = ticket("`src/gone.ts` holds `gone()`; run `npm run gone:script`.");
    expect(premiseProblems(premisesOf(body, DELIVERABLES), checkout)).toEqual([
      "stale premise: src/gone.ts (path) not found",
      "stale premise: gone (function) not found",
      "stale premise: gone:script (script) not found",
    ]);
  });

  it("treats a checkout without package.json as having no scripts", () => {
    const bare = mkdtempSync(join(tmpdir(), "premises-bare-"));
    expect(scriptNames(bare)).toEqual(new Set());
    expect(exportedNames(bare)).toEqual(new Set());
  });

  it("strips code blocks and details from prose", () => {
    expect(proseOf("a\n```\nb\n```\nc <details>d</details> e")).toBe("a\n\nc  e");
  });
});

describe("bare file names", () => {
  it("classifies a bare file name and leaves a version number or an abbreviation alone", () => {
    expect(classify("inject.ts")).toEqual({ token: "inject.ts", kind: "file" });
    expect(classify("CLAUDE.md")).toEqual({ token: "CLAUDE.md", kind: "file" });
    expect(classify("2.2.0")).toBeNull();
    expect(classify("e.g.")).toBeNull();
  });

  it("finds a bare file name anywhere in the checkout, and reports one that is nowhere", () => {
    const body = ticket(
      "`helpers.ts` is the model; extend the existing `vitest.config.test.ts`; `package.json` has the scripts.",
    );
    expect(premiseProblems(premisesOf(body, DELIVERABLES), checkout)).toEqual([
      "stale premise: vitest.config.test.ts (file) not found",
    ]);
  });
});

describe("sibling checkouts", () => {
  it("accepts a premise the ticket's repo lacks when a sibling repo of the factory has it", () => {
    const sibling = mkdtempSync(join(tmpdir(), "premises-sibling-"));
    writeFileSync(join(sibling, "INVARIANTS.md"), "# invariants\n");
    const body = ticket("Spread across the target's `INVARIANTS.md`; `src/helpers.ts` stays.");
    expect(premiseProblems(premisesOf(body, DELIVERABLES), checkout)).toEqual([
      "stale premise: INVARIANTS.md (file) not found",
    ]);
    expect(premiseProblems(premisesOf(body, DELIVERABLES), checkout, [sibling, "/no/such/dir"])).toEqual([]);
  });
});

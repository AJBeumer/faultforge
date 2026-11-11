import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { git, gitRepo } from "./fixtures/git-repo.ts";
import { classify, premiseProblems, premisesOf, proseOf } from "./ticket-premises.ts";

const DELIVERABLES = ["Result", "Done when"];

/** The ticket's repo: one script family, a module with exports, an imported builtin, a doc, private storage. */
let checkout: string;
beforeAll(() => {
  checkout = gitRepo({
    "package.json": JSON.stringify({ scripts: { check: "vitest", "ticket:ready": "tsx x" } }),
    "src/helpers.ts":
      'import { existsSync } from "node:fs";\nimport {\n  renameSync,\n  statSync,\n} from "node:fs";\nexport function privateDir() {}\nexport const loadFactory = () => 1;\nfunction hidden() {}\nexport default function entry() {}\nexport { hidden as shown };\n',
    "src/main.js": "export class Runner {}\n",
    "src/a-unicode.ts":
      "// 🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀 multi-byte characters before the export\nexport function afterUnicode() {}\n// ✓✓✓\n",
    "docs/guide.md": "# guide\n",
  });
  // The working tree differs from origin/main: a file main lacks, and private storage, which is never committed.
  writeFileSync(join(checkout, "src", "only-in-tree.ts"), "export function onlyInTree() {}\n");
  mkdirSync(join(checkout, "private"), { recursive: true });
  writeFileSync(join(checkout, "private", "BACKLOG.md"), "- todo\n");
});

const ticket = (notes: string, done = "- [ ] New `src/report.ts` prints it") => `### Result
A thing that reads \`src/helpers.ts\`.

### Done when
${done}

### Must not break
- \`npm run check\` stays green

### Notes
${notes}`;

const problems = (notes: string, siblings: string[] = []) =>
  premiseProblems(premisesOf(ticket(notes), DELIVERABLES), checkout, siblings);

const HERE = "not found on origin/main of the ticket's repo";

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

  it("skips a token the same sentence introduces as new", () => {
    const body = ticket("Add a new `src/report.ts` beside `src/helpers.ts`; it gains `report()`.");
    expect(premisesOf(body, DELIVERABLES)).toEqual([
      { token: "check", kind: "script" },
      { token: "src/helpers.ts", kind: "path" },
    ]);
  });

  it("stops the 'new' look-back at the end of the line or clause (blind review 2, Qodo 10)", () => {
    const body = ticket("- Adds a dry-run flag\n- Reads `src/gone.ts` for the list; also `src/helpers.ts`");
    expect(premisesOf(body, DELIVERABLES).map((p) => p.token)).toEqual(["check", "src/gone.ts", "src/helpers.ts"]);
  });

  it("ignores tokens inside code blocks, indented code blocks and details blocks with attributes (Qodo 9, blind 10)", () => {
    const body = ticket(
      "Assumes `src/helpers.ts`.\n\n```\nsee `src/gone.ts`\n```\n\n- item\n  ```md\n  `src/also-gone.ts`\n  ```\n\n<details open>\n<summary>Original</summary>\nused `old:script`\n</details>",
    );
    expect(premisesOf(body, DELIVERABLES).map((p) => p.token)).toEqual(["check", "src/helpers.ts"]);
  });

  it("skips private paths, with or without a leading ./, URLs, placeholders and directories (Qodo 3)", () => {
    const body = ticket(
      "Snapshot in `private/config/qodo-v6/rules.json` or `./private/x.json`; see `https://example.org/a.md`, `raw-artifacts/<ts>/x.json`, `packages/harness/src/`.",
    );
    expect(premisesOf(body, DELIVERABLES).map((p) => p.token)).toEqual(["check"]);
  });

  it("skips the Out of scope section, which names what will not exist (blind 12)", () => {
    const body = `${ticket("Reads `src/helpers.ts`.")}\n\n### Out of scope\n- A \`premise:fix\` script and \`docs/premises.md\``;
    expect(premisesOf(body, [...DELIVERABLES, "Out of scope"]).map((p) => p.token)).toEqual([
      "check",
      "src/helpers.ts",
    ]);
  });

  it("strips a line reference from a path", () => {
    expect(classify("packages/harness/src/inject.ts:68")).toEqual({
      token: "packages/harness/src/inject.ts",
      kind: "path",
    });
    expect(classify("src/a.ts:10-12")).toEqual({ token: "src/a.ts", kind: "path" });
  });

  it("reads the script name out of npm run, with or without arguments (Qodo 4, blind 4)", () => {
    expect(classify("npm run qodo:check")).toEqual({ token: "qodo:check", kind: "script" });
    expect(classify("npm run -s check")).toEqual({ token: "check", kind: "script" });
    expect(classify("npm run test:integration -- --runInBand")).toEqual({ token: "test:integration", kind: "script" });
    expect(classify("npm run ticket:ready -- faultforge 47")).toEqual({ token: "ticket:ready", kind: "script" });
  });

  it("does not read a module specifier or a search qualifier as an npm script (blind 3)", () => {
    for (const token of [
      "node:fs",
      "node:child_process",
      "is:open",
      "label:ready-for-agent",
      "state:open",
      "repo:a-b",
    ]) {
      expect(classify(token)).toBeNull();
    }
  });

  it("names each premise once", () => {
    const body = ticket("`src/helpers.ts` twice: `src/helpers.ts`.");
    expect(premisesOf(body, DELIVERABLES).filter((p) => p.kind === "path")).toHaveLength(1);
  });

  it("leaves prose, commands with spaces and plain words alone", () => {
    for (const token of ["git -C private", "main", "FAULTFORGE_PRIVATE_DIR", "Done when", "x = 1", "2.2.0", "e.g."]) {
      expect(classify(token)).toBeNull();
    }
  });

  it("classifies a bare file name", () => {
    expect(classify("inject.ts")).toEqual({ token: "inject.ts", kind: "file" });
    expect(classify("CLAUDE.md")).toEqual({ token: "CLAUDE.md", kind: "file" });
  });
});

describe("premiseProblems reads origin/main, not the working tree (Qodo 1, blind 1)", () => {
  it("reports nothing when every premise is on main", () => {
    expect(
      problems(
        "Reuse `privateDir()` and `loadFactory()` from `src/helpers.ts`; `docs/guide.md` and `helpers.ts` explain it.",
      ),
    ).toEqual([]);
  });

  it("reports a file that exists only in the working tree, because the run builds from main", () => {
    expect(problems("Extend `src/only-in-tree.ts` and reuse `onlyInTree()`.")).toEqual([
      `stale premise: src/only-in-tree.ts (path) ${HERE}`,
      `stale premise: onlyInTree (function) ${HERE}`,
    ]);
  });

  it("reports a missing file by path and by bare name", () => {
    expect(problems("Extend the existing `src/vitest.config.test.ts` and `vitest.config.test.ts`.")).toEqual([
      `stale premise: src/vitest.config.test.ts (path) ${HERE}`,
      `stale premise: vitest.config.test.ts (file) ${HERE}`,
    ]);
  });

  it("reports a missing script", () => {
    expect(problems("`qodo:check` runs first; `npm run mutation:check -- --all` after.")).toEqual([
      `stale premise: qodo:check (script) ${HERE}`,
      `stale premise: mutation:check (script) ${HERE}`,
    ]);
  });

  it("reports a function that exists nowhere, but accepts declared, imported, default, aliased and class names (blind 5, 8; Qodo round 2: multi-line imports)", () => {
    expect(problems("`resolvePrivate()` and `report()` are elsewhere.")).toEqual([
      `stale premise: resolvePrivate (function) ${HERE}`,
      `stale premise: report (function) ${HERE}`,
    ]);
    expect(
      problems(
        "`hidden()`, `existsSync()`, `renameSync()`, `entry()`, `shown()` and `Runner()` all exist in some form.",
      ),
    ).toEqual([]);
  });

  it("finds a name declared after multi-byte characters, in a file after a multi-byte file (Qodo round 3)", () => {
    expect(problems("Reuse `afterUnicode()` and `privateDir()`.")).toEqual([]);
  });

  it("does not let a path escape the checkout (Qodo 7)", () => {
    expect(problems("See `../outside.ts`.")).toEqual([`stale premise: ../outside.ts (path) ${HERE}`]);
  });

  it("accepts a bare name of a private file when private storage is beside the checkout (blind 7)", () => {
    expect(problems("Append to `BACKLOG.md`.")).toEqual([]);
  });

  it("reports every stale premise at once, in the ticket's order", () => {
    expect(problems("`src/gone.ts` holds `gone()`; run `npm run gone:script`.")).toEqual([
      `stale premise: src/gone.ts (path) ${HERE}`,
      `stale premise: gone (function) ${HERE}`,
      `stale premise: gone:script (script) ${HERE}`,
    ]);
  });

  it("accepts a premise a sibling repo has, and names the places searched when nothing has it (Qodo 2, 11)", () => {
    const sibling = gitRepo({ "INVARIANTS.md": "# invariants\n" });
    expect(problems("Spread across the target's `INVARIANTS.md`; `src/helpers.ts` stays.")).toEqual([
      `stale premise: INVARIANTS.md (file) ${HERE}`,
    ]);
    expect(problems("Spread across the target's `INVARIANTS.md`.", [sibling, "/no/such/dir"])).toEqual([]);
    expect(problems("See `src/gone.ts`.", [sibling])).toEqual([
      `stale premise: src/gone.ts (path) ${HERE} or 1 sibling repo`,
    ]);
  });

  it("throws, rather than guessing, when the checkout has no origin/main", () => {
    const bare = mkdtempSync(join(tmpdir(), "premises-bare-"));
    git(bare, "init", "-q");
    expect(() => premiseProblems([{ token: "src/x.ts", kind: "path" }], bare)).toThrow(/origin\/main/);
  });

  it("strips code blocks and details from prose", () => {
    expect(proseOf("a\n```\nb\n```\nc <details>d</details> e")).toBe("a\n\nc  e");
  });
});

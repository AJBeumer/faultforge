import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEntry } from "./cli-entry.ts";
import { type InjectArgs, type InjectDeps, main, run, variantFailure } from "./inject-case.ts";
import { applyTestChange, loadTemplates, type Proof, proofCorpus, testChangeFileProblem } from "./inject-template.ts";
import { eventProblems } from "./ledger-append.ts";
import { answerKeyEntryProblem } from "./ledger-schemas.ts";
import type { Outcome } from "./run-outcome.ts";

const BASE = "b".repeat(40);
const PLANTED = "d".repeat(40);
const FIND = "  return total;\n";

const BUG = {
  schemaVersion: 2,
  id: "x-secret-v1",
  kind: "bug",
  invariantId: "INV-X-001",
  defectClass: "off-by-one",
  summary: "Returns one too many.",
  file: "src/sum.ts",
  find: FIND,
  replace: "  return total + 1;\n",
  proofTest: "proof.test.ts",
  match: { kindTerms: ["off by one"] },
  alsoBreaks: [],
  publish: { branch: "tidy-sum", commitMessage: "Tidy the sum" },
  ticket: { title: "Tidy the sum", what: "Tidy it.", criteria: ["Tests still pass."] },
};
const CONTROL = {
  schemaVersion: 2,
  id: "x-control-v1",
  kind: "control",
  summary: "Renames a local.",
  file: "src/sum.ts",
  find: FIND,
  replace: "  return total; // same\n",
  publish: { branch: "tidy-sum-comment", commitMessage: "Comment the sum" },
  ticket: { title: "Comment the sum", what: "Comment it.", criteria: ["Tests still pass."] },
};

interface Script {
  /** Outcome of each proof on base and on the variant (by position). */
  base?: Outcome[];
  variant?: Outcome[];
  typecheck?: Outcome;
  publicTests?: Outcome;
  status?: string;
  head?: string;
  originMain?: string;
  gitThrows?: string;
  corpus?: Proof[];
  unguarded?: string;
  lint?: Outcome;
  addedTest?: Outcome;
  /** Fields that replace the bug or control template's own. */
  bug?: Record<string, unknown>;
  control?: Record<string, unknown>;
}

const TEST_FILE = 'import { sum } from "../src/sum";\n\nit("sums", () => {});\n';

/** Private storage with both templates, a target with the file to change, and fakes for everything else. */
function world(script: Script = {}) {
  const priv = mkdtempSync(join(tmpdir(), "inject-priv-"));
  const bug = { ...BUG, ...script.bug };
  const control = { ...CONTROL, ...script.control };
  for (const t of [bug, control]) {
    mkdirSync(join(priv, "templates", t.id), { recursive: true });
    writeFileSync(join(priv, "templates", t.id, "template.json"), JSON.stringify(t));
  }
  writeFileSync(join(priv, "templates", BUG.id, "proof.test.ts"), "// proof\n");
  writeFileSync(join(priv, "ground-truth.jsonl"), `${JSON.stringify({ caseId: "FF-9500", kind: "sabotage" })}\n`);
  const target = mkdtempSync(join(tmpdir(), "inject-target-"));
  mkdirSync(join(target, "src"));
  writeFileSync(join(target, "src", "sum.ts"), `export function sum() {\n  const total = 1;\n${FIND}}\n`);
  mkdirSync(join(target, "test"));
  writeFileSync(join(target, "test", "sum.test.ts"), TEST_FILE);
  /** The test folder's files and the edited test's text, each time a proof ran on the variant. */
  const testsAtVariant: string[][] = [];
  const gitCalls: string[][] = [];
  const steps: string[][] = [];
  let committed = false;
  const deps: InjectDeps = {
    privateDir: priv,
    findTemplateDir: (id) => join(priv, "templates", id),
    corpus: () =>
      script.corpus ?? [{ invariantId: "INV-X-001", proofTest: "proof.test.ts", dir: join(priv, "templates", BUG.id) }],
    allTemplates: () => [bug, control] as never,
    ledgerProblems: () => [],
    git: (_dir, ...args) => {
      gitCalls.push(args);
      if (script.gitThrows && args[0] === script.gitThrows) throw new Error(`git ${args[0]} failed`);
      if (args[0] === "status") return script.status ?? "";
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return script.head ?? "main";
      if (args.join(" ") === "rev-parse HEAD") return committed ? PLANTED : BASE;
      if (args[0] === "commit") committed = true;
      if (args[0] === "remote") return "https://github.com/Owner/target.git";
      return "";
    },
    originMain: () => script.originMain ?? BASE,
    branches: () => ({ existsLocally: () => false, existsOnOrigin: () => false }),
    baseTreeProblems: () => [],
    guardProblem: () => script.unguarded,
    diff: () => ({ status: 0, stdout: "diff", stderr: "" }),
    runProof: (_places, stage, _proof, i) => {
      if (stage === "variant") {
        const files = readdirSync(join(target, "test")).map(String).sort();
        testsAtVariant.push([...files, readFileSync(join(target, "test", "sum.test.ts"), "utf8")]);
      }
      return stage === "base" ? ((script.base ?? [])[i] ?? "pass") : ((script.variant ?? [])[i] ?? "fail");
    },
    runStep: (_places, name, _cmd, args) => {
      steps.push([name, ...args]);
      const outcomes: Record<string, Outcome | undefined> = {
        typecheck: script.typecheck,
        lint: script.lint,
        "public-tests": script.publicTests,
        "added-test": script.addedTest,
      };
      return outcomes[name] ?? "pass";
    },
    now: () => "2026-11-14T02:00:00.000Z",
    log: () => {},
    error: (line) => errors.push(line),
  };
  const errors: string[] = [];
  const inject = (args: Partial<InjectArgs> = {}) =>
    run({ template: BUG.id, target, caseId: "FF-9501", validateOnly: false, ...args }, deps);
  const lines = (file: string) =>
    readFileSync(join(priv, file), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { priv, target, deps, inject, lines, gitCalls, steps, errors, testsAtVariant };
}

const auditFile = (w: ReturnType<typeof world>) => {
  try {
    return w.lines("audit-events.jsonl");
  } catch {
    return [];
  }
};

describe("inject run(deps): the gates (AUD-M6, #252)", () => {
  it("plants a validated bug, keeps every earlier answer-key line, and writes a valid event", () => {
    const w = world();
    expect(w.inject()).toBe(0);
    expect(w.lines("ground-truth.jsonl").map((e) => e.caseId)).toEqual(["FF-9500", "FF-9501"]);
    expect(w.lines("ground-truth.jsonl")[1]).toMatchObject({
      injectionCommit: PLANTED,
      targetCommit: BASE,
      injectedLines: [3, 3],
      validation: { proofs: [{ proofOnBase: "pass", proofOnVariant: "fail" }] },
    });
    const [event] = auditFile(w);
    expect(eventProblems(event)).toEqual([]);
    expect(answerKeyEntryProblem(w.lines("ground-truth.jsonl")[1])).toBeUndefined();
    expect(readFileSync(join(w.target, "src", "sum.ts"), "utf8")).toContain("total + 1");
  });

  it("refuses a proof that still passes on the variant, and leaves no branch and no record (I03)", () => {
    const w = world({ variant: ["pass"] });
    expect(w.inject()).toBe(1);
    expect(w.errors.join("\n")).toContain("still passes on the variant");
    expect(w.gitCalls).toContainEqual(["branch", "--quiet", "-D", "tidy-sum"]);
    expect(w.lines("ground-truth.jsonl")).toHaveLength(1);
    expect(auditFile(w)).toEqual([]);
  });

  it("refuses a proof that fails, or never ran, on the base commit (I04, I08)", () => {
    expect(world({ base: ["fail"] }).inject()).toBe(1);
    const notRun = world({ base: ["not_run"] });
    expect(notRun.inject()).toBe(1);
    expect(notRun.errors.join("\n")).toContain("did not finish, or ran no test, on the base commit");
  });

  it("refuses to plant, or validate, next to an answer key or audit log with problems, and touches nothing (#224)", () => {
    for (const validateOnly of [false, true]) {
      const w = world();
      const checked: string[][] = [];
      w.deps.ledgerProblems = (paths) => {
        checked.push(paths);
        return ["amendment amending FF-9500: changes injectedLines"];
      };
      expect(w.inject(validateOnly ? { validateOnly, caseId: undefined } : {})).toBe(1);
      expect(checked).toEqual([[join(w.priv, "ground-truth.jsonl"), join(w.priv, "audit-events.jsonl")]]);
      expect(w.errors.join("\n")).toContain("the answer key or audit log has problems: amendment amending FF-9500");
      expect(w.gitCalls).toEqual([]);
      expect(w.lines("ground-truth.jsonl")).toHaveLength(1);
      expect(auditFile(w)).toEqual([]);
    }
  });

  it("refuses a case id already in the answer key (I06), and a malformed one", () => {
    const w = world();
    expect(w.inject({ caseId: "FF-9500" })).toBe(1);
    expect(w.errors.join("\n")).toContain("FF-9500 is already in the ledger");
    expect(w.inject({ caseId: "FF-95" })).toBe(1);
    expect(w.lines("ground-truth.jsonl")).toHaveLength(1);
  });

  it("refuses a real case in a target without git's guard, but validates there (#242)", () => {
    const w = world({ unguarded: "the target has no guard" });
    expect(w.inject()).toBe(1);
    expect(w.errors.join(" ")).toContain("Run npm run guard:install first");
    expect(world({ unguarded: "x" }).inject({ validateOnly: true, caseId: undefined })).toBe(0);
  });

  it("refuses a dirty checkout (I07), a detached HEAD, and a HEAD that isn't origin/main", () => {
    expect(world({ status: " M src/sum.ts" }).inject()).toBe(1);
    expect(world({ head: "HEAD" }).inject()).toBe(1);
    expect(world({ originMain: "e".repeat(40) }).inject()).toBe(1);
  });

  it("refuses a variant whose typecheck or public tests didn't finish, or that doesn't typecheck (I11, I13)", () => {
    expect(world({ typecheck: "not_run" }).inject()).toBe(1);
    expect(world({ typecheck: "fail" }).inject()).toBe(1);
    expect(world({ publicTests: "not_run" }).inject()).toBe(1);
  });

  it("typechecks with the target's tsconfig.test.json when it has one (AUD-N7)", () => {
    const plain = world();
    plain.inject();
    expect(plain.steps.find((s) => s[0] === "typecheck")).toContain("tsconfig.json");
    const withTest = world();
    writeFileSync(join(withTest.target, "tsconfig.test.json"), "{}");
    withTest.inject();
    expect(withTest.steps.find((s) => s[0] === "typecheck")).toContain("tsconfig.test.json");
  });

  it("exits 2, not 1, on an unexpected error", () => {
    const w = world({ gitThrows: "status" });
    expect(w.inject()).toBe(2);
    expect(w.errors.join("\n")).toContain("unexpected error");
  });

  it("leaves nothing behind in --validate-only", () => {
    const w = world();
    expect(w.inject({ validateOnly: true, caseId: undefined })).toBe(0);
    expect(w.lines("ground-truth.jsonl")).toHaveLength(1);
    expect(w.gitCalls.some((c) => c[0] === "commit")).toBe(false);
  });
});

describe("inject run(deps): a control must pass the whole proof corpus (AUD-M8, #252)", () => {
  it("refuses a real bug labelled as a control: a corpus proof fails on its variant", () => {
    const w = world({ variant: ["fail"] });
    expect(w.inject({ template: CONTROL.id })).toBe(1);
    expect(w.errors.join("\n")).toContain("fails proofs in the corpus, so it is not a clean control");
    expect(w.lines("ground-truth.jsonl")).toHaveLength(1);
  });

  it("plants a control whose variant passes every corpus proof, and says how many", () => {
    const w = world({ variant: ["pass"] });
    expect(w.inject({ template: CONTROL.id })).toBe(0);
    const proofTest = expect.stringMatching(/^x-secret-v1\/proof\.test\.ts@sha256:[0-9a-f]{64}$/);
    expect(w.lines("ground-truth.jsonl")[1]).toMatchObject({
      kind: "control",
      validation: { corpus: [{ proofTest, proofOnBase: "pass", proofOnVariant: "pass" }] },
    });
    expect(answerKeyEntryProblem(w.lines("ground-truth.jsonl")[1])).toBeUndefined();
    expect(eventProblems(auditFile(w)[0])).toEqual([]);
  });

  it("refuses in --validate-only too, and when there is no corpus to check against", () => {
    expect(world({ variant: ["fail"] }).inject({ template: CONTROL.id, validateOnly: true, caseId: undefined })).toBe(
      1,
    );
    expect(world({ corpus: [] }).inject({ template: CONTROL.id })).toBe(1);
  });
});

describe("variantFailure", () => {
  const proof: Proof[] = [{ invariantId: "I", proofTest: "p" }];
  it("reads a passing proof as a failure for a bug and as the norm for a control", () => {
    expect(variantFailure({ kind: "bug" }, proof, ["pass"], "pass", "pass")).toContain("still passes");
    expect(variantFailure({ kind: "control" }, proof, ["pass"], "pass", "pass")).toBeUndefined();
    expect(variantFailure({ kind: "control" }, proof, ["pass"], "pass", "fail")).toContain("public tests");
  });
});

describe("the entry: every unexpected error is exit 2, at load time too (#252)", () => {
  it("returns 2 when the body fails to load, and when it throws", async () => {
    const quiet = () => {};
    expect(await runEntry("x", () => Promise.reject(new Error("bad import")), [], 2, quiet)).toBe(2);
    expect(
      await runEntry(
        "x",
        async () => () => {
          throw new Error("boom");
        },
        [],
        2,
        quiet,
      ),
    ).toBe(2);
    expect(await runEntry("x", async () => () => 0, [], 2, quiet)).toBe(0);
  });

  it("reads a usage problem as a refusal, 1", () => {
    expect(main([], () => world().deps)).toBe(1);
    expect(main(["--nonsense"], () => world().deps)).toBe(1);
  });
});

describe("the entry files load nothing that could fail before their handler exists (#252)", () => {
  it.each(["inject.ts", "review-wait.ts"])(
    "%s imports only cli-entry.ts statically, and loads its body inside runEntry",
    (file) => {
      const text = readFileSync(join(import.meta.dirname, file), "utf8");
      expect([...text.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1])).toEqual(["./cli-entry.ts"]);
      expect(text).toMatch(/await runEntry\(\s*"[\w:]+",\s*async \(\) =>/);
      expect(text).toMatch(/\(await import\("\.\/[\w-]+-(case|run)\.ts"\)\)\.main/);
    },
  );
});

describe("proofCorpus: a template still being written (Qodo on PR 271)", () => {
  it("is skipped and named, never stopping the control", () => {
    const root = mkdtempSync(join(tmpdir(), "corpus-"));
    mkdirSync(join(root, "good"));
    writeFileSync(join(root, "good", "template.json"), JSON.stringify({ ...BUG, id: "good" }));
    writeFileSync(join(root, "good", "proof.test.ts"), "// p\n");
    mkdirSync(join(root, "broken"));
    writeFileSync(join(root, "broken", "template.json"), "{ not json");
    mkdirSync(join(root, "unproven"));
    writeFileSync(join(root, "unproven", "template.json"), JSON.stringify({ ...BUG, id: "unproven" }));
    const skipped: string[] = [];
    const corpus = proofCorpus([root], (id) => skipped.push(id));
    expect(corpus.map((p) => p.dir)).toEqual([join(root, "good")]);
    expect(skipped.sort()).toEqual(["broken", "unproven"]);
  });
});

describe("proofCorpus: a broken private copy (Qodo on PR 271)", () => {
  it("never hides a good published copy of the same template", () => {
    const priv = mkdtempSync(join(tmpdir(), "corpus-priv-"));
    const seed = mkdtempSync(join(tmpdir(), "corpus-seed-"));
    mkdirSync(join(priv, "same"));
    writeFileSync(join(priv, "same", "template.json"), "{ half");
    mkdirSync(join(seed, "same"));
    writeFileSync(join(seed, "same", "template.json"), JSON.stringify({ ...BUG, id: "same" }));
    writeFileSync(join(seed, "same", "proof.test.ts"), "// p\n");
    expect(proofCorpus([priv, seed]).map((p) => p.dir)).toEqual([join(seed, "same")]);
  });
});

describe("inject: what Qodo found on PR 274", () => {
  it("names on the control's record any template left out of the corpus", () => {
    const w = world({ variant: ["pass"] });
    w.deps.corpusSkipped = () => ["x-draft-v1: its proof p.test.ts is missing"];
    expect(w.inject({ template: CONTROL.id })).toBe(0);
    expect(w.lines("ground-truth.jsonl")[1].validation.corpusSkipped).toEqual([
      "x-draft-v1: its proof p.test.ts is missing",
    ]);
  });

  it("never lets a half-written private copy, of any kind, hide a published bug template", () => {
    const priv = mkdtempSync(join(tmpdir(), "corpus-priv-"));
    const seed = mkdtempSync(join(tmpdir(), "corpus-seed-"));
    mkdirSync(join(priv, "same"));
    writeFileSync(join(priv, "same", "template.json"), JSON.stringify({ id: "same", kind: "control" }));
    mkdirSync(join(seed, "same"));
    writeFileSync(join(seed, "same", "template.json"), JSON.stringify({ ...BUG, id: "same" }));
    writeFileSync(join(seed, "same", "proof.test.ts"), "// p\n");
    expect(proofCorpus([priv, seed]).map((p) => p.dir)).toEqual([join(seed, "same")]);
    expect(loadTemplates([priv, seed]).map((t) => t.kind)).toEqual(["bug"]);
  });
});

describe("inject --validate-only runs the target's whole check on the variant", () => {
  const validate = (w: ReturnType<typeof world>, template = BUG.id) =>
    w.inject({ template, validateOnly: true, caseId: undefined });

  it("runs Biome and the public tests, as the target's own check does", () => {
    const w = world();
    expect(validate(w)).toBe(0);
    expect(w.steps.map((s) => s[0])).toEqual(["typecheck", "lint", "public-tests"]);
    expect(w.steps.find((s) => s[0] === "lint")?.join(" ")).toMatch(/biome.* check \.$/);
  });

  it("refuses a variant whose lint fails or doesn't finish", () => {
    const failing = world({ lint: "fail" });
    expect(validate(failing)).toBe(1);
    expect(failing.errors.join("\n")).toContain("the target's lint (Biome) fails on the variant");
    expect(validate(world({ lint: "not_run" }))).toBe(1);
  });

  it("refuses a bug variant whose public tests fail, which a real run records but a red check would show", () => {
    const w = world({ publicTests: "fail" });
    expect(validate(w)).toBe(1);
    expect(w.errors.join("\n")).toContain("the target's public tests fail on the variant");
  });

  it("leaves a real run as it was: no lint step, and a bug's failing public tests are recorded", () => {
    const w = world({ publicTests: "fail" });
    expect(w.inject()).toBe(0);
    expect(w.steps.map((s) => s[0])).toEqual(["typecheck", "public-tests"]);
    expect(w.lines("ground-truth.jsonl")[1].validation.publicTests).toBe("fail");
  });
});

describe("inject: a template's test change, in the same commit", () => {
  const EDIT = {
    file: "test/sum.test.ts",
    find: 'it("sums", () => {});\n',
    replace: 'it("sums", () => {});\nit("sums twice", () => {});\n',
  };
  const NEW = { file: "test/extra.test.ts", content: 'it("adds", () => {});\n' };

  it("applies an edit to a test before the proofs and checks run, runs that test, and records it", () => {
    const w = world({ bug: { testChange: EDIT } });
    expect(w.inject()).toBe(0);
    expect(readFileSync(join(w.target, "test", "sum.test.ts"), "utf8")).toContain("sums twice");
    expect(w.testsAtVariant[0]?.[1]).toContain("sums twice");
    expect(w.steps).toContainEqual(["added-test", expect.stringContaining("vitest"), "run", "test/sum.test.ts"]);
    expect(w.lines("ground-truth.jsonl")[1].validation.addedTest).toBe("pass");
    expect(answerKeyEntryProblem(w.lines("ground-truth.jsonl")[1])).toBeUndefined();
  });

  it("creates a new test file and tells git about it, so the diff and the commit hold it", () => {
    const w = world({ control: { testChange: NEW }, variant: ["pass"] });
    expect(w.inject({ template: CONTROL.id })).toBe(0);
    expect(existsSync(join(w.target, "test", "extra.test.ts"))).toBe(true);
    expect(w.gitCalls).toContainEqual(["add", "--intent-to-add", "--", "test/extra.test.ts"]);
    const add = w.gitCalls.findIndex((c) => c[0] === "add");
    expect(add).toBeLessThan(w.gitCalls.findIndex((c) => c[0] === "commit"));
    // The corpus ran with the control's test in place.
    expect(w.testsAtVariant[0]).toContain("extra.test.ts");
  });

  it("refuses a bug whose added test fails on the variant, and a control whose added test breaks a corpus proof", () => {
    const w = world({ bug: { testChange: EDIT }, addedTest: "fail" });
    expect(w.inject()).toBe(1);
    expect(w.errors.join("\n")).toContain("the test the change adds fails on the variant");
    expect(w.lines("ground-truth.jsonl")).toHaveLength(1);
    expect(world({ control: { testChange: NEW }, variant: ["fail"] }).inject({ template: CONTROL.id })).toBe(1);
  });

  it("refuses a test change in the same file as the change, one that gives the case away, or find text not found", () => {
    const same = world({ bug: { testChange: { ...EDIT, file: "src/sum.ts" } } });
    expect(same.inject()).toBe(1);
    expect(same.errors.join("\n")).toContain("testChange must change a test file");
    const telling = world({ bug: { testChange: { ...NEW, content: "// x-secret-v1\n" } } });
    expect(telling.inject()).toBe(1);
    expect(telling.errors.join("\n")).toContain("testChange.content: names x-secret-v1");
    expect(world({ bug: { testChange: { ...EDIT, find: "nowhere\n" } } }).inject()).toBe(2);
  });

  it("refuses a bug's test that names its own kind terms, which the ticket may not either (Qodo on PR 293)", () => {
    const w = world({ bug: { testChange: { ...NEW, content: 'it("is not off by one", () => {});\n' } } });
    expect(w.inject()).toBe(1);
    expect(w.errors.join("\n")).toContain("testChange.content: restates what the change breaks (off by one)");
  });

  it("refuses a test change to git's own folder, or to a file that isn't a test (Qodo on PR 293)", () => {
    const git = world({ control: { testChange: { file: ".git/config", content: "[x]\n" } }, variant: ["pass"] });
    expect(git.inject({ template: CONTROL.id, validateOnly: true, caseId: undefined })).toBe(1);
    expect(git.errors.join("\n")).toContain("may not touch git's own folder");
    expect(existsSync(join(git.target, ".git", "config"))).toBe(false);
    const prod = world({ bug: { testChange: { file: "src/other.ts", content: "export const x = 1;\n" } } });
    expect(prod.inject()).toBe(1);
  });
});

describe("testChangeFileProblem and applyTestChange (Qodo on PR 293)", () => {
  it("sees the main change's file however it is spelled", () => {
    expect(testChangeFileProblem("./test//a.test.ts", "test/a.test.ts")).toContain("another file");
    expect(testChangeFileProblem("test/b.test.ts", "test/a.test.ts")).toBeUndefined();
    expect(testChangeFileProblem("test/.GIT/x.test.ts", "src/a.ts")).toContain("git's own folder");
  });

  it("never writes through a link out of the target", (context) => {
    const target = mkdtempSync(join(tmpdir(), "test-change-target-"));
    const outside = mkdtempSync(join(tmpdir(), "test-change-outside-"));
    try {
      symlinkSync(outside, join(target, "test"), "junction");
    } catch {
      context.skip(); // a link can't be made here
    }
    expect(() => applyTestChange(target, { file: "test/x.test.ts", content: "it();\n" })).toThrow(/outside the target/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a test change kept in test-change.json beside template.json, rather than ignore it", () => {
    const w = world();
    writeFileSync(
      join(w.priv, "templates", BUG.id, "test-change.json"),
      JSON.stringify({ file: "test/sum.test.ts", find: "x", replace: "y" }),
    );
    expect(w.inject()).toBe(1);
    expect(w.errors.join("\n")).toContain("move it into template.json as testChange");
  });

  it("refuses a test change that is neither an edit nor a new file (schema)", () => {
    const w = world({ bug: { testChange: { file: "test/sum.test.ts" } } });
    expect(w.inject()).toBe(1);
    expect(w.errors.join("\n")).toContain("fails the schema");
  });
});

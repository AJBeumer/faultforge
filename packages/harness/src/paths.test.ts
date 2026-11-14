import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "./factory-config.ts";
import { caseIdOk, evidenceDir, evidenceKindDir, prEvidenceDir, privateDir, ROOT, runsDir } from "./paths.ts";

const factory = (evidence: string): FactoryConfig => ({ evidence, repos: {} });

describe("ROOT", () => {
  it("is this repository's root", () => {
    expect(join(ROOT, "factory.json")).toBe(join(import.meta.dirname, "../../../factory.json"));
  });
});

describe("evidenceDir", () => {
  it("resolves factory.json's evidence under the given root", () => {
    expect(evidenceDir(factory("private/raw-artifacts"), "/repo")).toBe(resolve("/repo", "private/raw-artifacts"));
  });

  it("defaults to the checked-in factory.json", () => {
    expect(evidenceDir()).toBe(join(ROOT, "private/raw-artifacts"));
  });
});

describe("privateDir", () => {
  it("honours FAULTFORGE_PRIVATE_DIR over anything evidence-derived", () => {
    expect(privateDir({ FAULTFORGE_PRIVATE_DIR: "/elsewhere" }, factory("private/raw-artifacts"))).toBe(
      resolve("/elsewhere"),
    );
  });

  it("defaults to the parent of the evidence folder (private/raw-artifacts -> private/)", () => {
    expect(privateDir({}, factory("private/raw-artifacts"))).toBe(join(ROOT, "private"));
  });

  it("moves with a non-default evidence path, the one function every script calls", () => {
    expect(privateDir({}, factory("private/custom-artifacts"))).toBe(join(ROOT, "private"));
    expect(privateDir({}, factory("not-private/raw-artifacts"))).toBe(join(ROOT, "not-private"));
  });
});

// A non-default evidence path handled the same way by a real script, not just by this module's own
// functions, is proven end to end in rules-propose.test.ts ("reads cases and ground truth from a
// non-default evidence path..."), which drives rules-propose.ts's propose() against a factory.json
// whose evidence isn't under "private/" at all.

describe("runsDir", () => {
  it("honours FAULTFORGE_RUNS_DIR", () => {
    const original = process.env.FAULTFORGE_RUNS_DIR;
    process.env.FAULTFORGE_RUNS_DIR = "/elsewhere/runs";
    try {
      expect(runsDir()).toBe(resolve("/elsewhere/runs"));
    } finally {
      if (original === undefined) delete process.env.FAULTFORGE_RUNS_DIR;
      else process.env.FAULTFORGE_RUNS_DIR = original;
    }
  });

  it("otherwise sits next to the given root", () => {
    const original = process.env.FAULTFORGE_RUNS_DIR;
    delete process.env.FAULTFORGE_RUNS_DIR;
    try {
      expect(runsDir("/checkout/faultforge")).toBe(resolve("/checkout", "faultforge-runs"));
    } finally {
      if (original !== undefined) process.env.FAULTFORGE_RUNS_DIR = original;
    }
  });
});

describe("prEvidenceDir and evidenceKindDir: one spelling of the per-PR evidence folders", () => {
  it("builds <evidence>/<kind> and <evidence>/<kind>/<repo>-pr<N> under any evidence folder", () => {
    const evidence = join(ROOT, "x", "raw-artifacts");
    expect(evidenceKindDir(evidence, "reviews")).toBe(join(evidence, "reviews"));
    expect(prEvidenceDir(evidence, "reviews", "faultforge", 12)).toBe(join(evidence, "reviews", "faultforge-pr12"));
    expect(prEvidenceDir(evidence, "revert-checks", "target", "3")).toBe(join(evidence, "revert-checks", "target-pr3"));
  });
});

/**
 * Every place outside `paths.ts` that spells a per-PR evidence folder itself: a `join` with "reviews" or
 * "revert-checks" as a literal part, or a template that builds `<key>-pr<N>` from two values. Such a copy
 * once drifted from the folder review:wait writes (AUD-M24); the helpers above are the one place.
 */
function handBuiltEvidencePaths(file: string, text: string): string[] {
  const patterns = [/\bjoin\((?:[^()]|\([^()]*\))*?["'](?:reviews|revert-checks)["']/g, /`\$\{[^}]+\}-pr\$\{[^}]+\}`/g];
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((m) => `${file}:${text.slice(0, m.index).split("\n").length}`),
  );
}

describe("handBuiltEvidencePaths", () => {
  it("finds a hand-built reviews or revert-checks folder, and a hand-built <key>-pr<N>", () => {
    expect(handBuiltEvidencePaths("a.ts", 'join(root, ev, "reviews", sub)')).toEqual(["a.ts:1"]);
    expect(handBuiltEvidencePaths("a.ts", "x\njoin(lab, e, 'revert-checks')")).toEqual(["a.ts:2"]);
    expect(handBuiltEvidencePaths("a.ts", "const sub = `${argv[0]}-pr${argv[1]}`;")).toEqual(["a.ts:1"]);
  });

  it("leaves names that aren't a built path: a scratch folder with a prefix, a comparison", () => {
    expect(handBuiltEvidencePaths("a.ts", "join(runs, `verify-${id}-${key}-pr${pr}`)")).toEqual([]);
    expect(handBuiltEvidencePaths("a.ts", 'if (entry.name === "reviews") walk()')).toEqual([]);
    expect(handBuiltEvidencePaths("a.ts", 'evidenceKindDir(join(lab, factory.evidence), "reviews")')).toEqual([]);
    expect(handBuiltEvidencePaths("a.ts", 'join(prEvidenceDir(join(t, e), "reviews", k, n), "x.json")')).toEqual([]);
  });
});

describe("the harness sources", () => {
  it("build no per-PR evidence folder by hand: only paths.ts spells one", () => {
    const dir = import.meta.dirname;
    const found = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "paths.ts")
      .flatMap((f) => handBuiltEvidencePaths(f, readFileSync(join(dir, f), "utf8")));
    expect(found).toEqual([]);
  });
});

describe("caseIdOk (#299)", () => {
  it("takes FF- and four digits, and says why anything else is refused", () => {
    const errors: string[] = [];
    expect(caseIdOk("FF-0001", "t", (l) => errors.push(l))).toBe(true);
    expect(caseIdOk("../FF-0001", "t", (l) => errors.push(l))).toBe(false);
    expect(errors).toEqual(['t: a case id is FF- and four digits, not "../FF-0001"']);
  });
});

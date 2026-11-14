import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "./factory-config.ts";
import { caseIdOk, evidenceDir, privateDir, ROOT, runsDir } from "./paths.ts";

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

describe("caseIdOk (#299)", () => {
  it("takes FF- and four digits, and says why anything else is refused", () => {
    const errors: string[] = [];
    expect(caseIdOk("FF-0001", "t", (l) => errors.push(l))).toBe(true);
    expect(caseIdOk("../FF-0001", "t", (l) => errors.push(l))).toBe(false);
    expect(errors).toEqual(['t: a case id is FF- and four digits, not "../FF-0001"']);
  });
});

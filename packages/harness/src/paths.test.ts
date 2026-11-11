import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "./factory-config.ts";
import { evidenceDir, privateDir, ROOT, runsDir } from "./paths.ts";

const factory = (evidence: string): FactoryConfig => ({ evidence, repos: {} });

describe("ROOT", () => {
  it("is this repository's root", () => {
    expect(join(ROOT, "factory.json")).toBe(join(import.meta.dirname, "../../../factory.json"));
  });
});

describe("evidenceDir", () => {
  it("resolves factory.json's evidence under the given root", () => {
    expect(evidenceDir(factory("private/raw-artifacts"), "/repo")).toBe(join("/repo", "private/raw-artifacts"));
  });

  it("defaults to the checked-in factory.json", () => {
    expect(evidenceDir()).toBe(join(ROOT, "private/raw-artifacts"));
  });
});

describe("privateDir", () => {
  it("honours FAULTFORGE_PRIVATE_DIR over anything evidence-derived", () => {
    expect(privateDir({ FAULTFORGE_PRIVATE_DIR: "/elsewhere" }, factory("private/raw-artifacts"))).toBe("/elsewhere");
  });

  it("defaults to the parent of the evidence folder (private/raw-artifacts -> private/)", () => {
    expect(privateDir({}, factory("private/raw-artifacts"))).toBe(join(ROOT, "private"));
  });

  it("handled the same way by every script: a non-default evidence path moves private/ with it", () => {
    // Every script resolves privateDir() from the configured evidence path, the same way, so a
    // factory.json whose evidence isn't under "private/" is never silently read as if it were.
    expect(privateDir({}, factory("private/custom-artifacts"))).toBe(join(ROOT, "private"));
    expect(privateDir({}, factory("not-private/raw-artifacts"))).toBe(join(ROOT, "not-private"));
  });
});

describe("runsDir", () => {
  it("honours FAULTFORGE_RUNS_DIR", () => {
    const original = process.env.FAULTFORGE_RUNS_DIR;
    process.env.FAULTFORGE_RUNS_DIR = "/elsewhere/runs";
    try {
      expect(runsDir()).toBe("/elsewhere/runs");
    } finally {
      if (original === undefined) delete process.env.FAULTFORGE_RUNS_DIR;
      else process.env.FAULTFORGE_RUNS_DIR = original;
    }
  });

  it("otherwise sits next to the given root", () => {
    const original = process.env.FAULTFORGE_RUNS_DIR;
    delete process.env.FAULTFORGE_RUNS_DIR;
    try {
      expect(runsDir("/checkout/faultforge")).toBe(join("/checkout", "faultforge-runs"));
    } finally {
      if (original !== undefined) process.env.FAULTFORGE_RUNS_DIR = original;
    }
  });
});

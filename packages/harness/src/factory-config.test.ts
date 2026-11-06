import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configProblems, loadFactory, repoConfig } from "./factory-config.ts";

const root = join(import.meta.dirname, "../../..");
const raw = readFileSync(join(root, "factory.json"), "utf8");

describe("factory.json", () => {
  const factory = loadFactory();

  it("is valid", () => {
    expect(configProblems(JSON.parse(raw))).toEqual([]);
  });

  it("describes this repo as the lab and the target as reviewed", () => {
    expect(repoConfig(factory, "faultforge")).toMatchObject({ github: "AJBeumer/faultforge", guard: "lab" });
    expect(repoConfig(factory, "target")).toMatchObject({ github: "AJBeumer/faultforge-target", guard: "reviewed" });
  });

  it("says how to start the target for a live check", () => {
    expect(repoConfig(factory, "target").start).toEqual({
      command: "npx tsx src/server.ts",
      port: 3000,
      health: "/health",
    });
  });

  it("keeps evidence in private storage", () => {
    expect(factory.evidence).toMatch(/^private\//);
  });

  it("holds no secrets or token paths", () => {
    expect(raw).not.toMatch(/token|secret|password|PAT_|key\.txt|\.github[/\\]PAT|\\Users\\/i);
  });
});

describe("configProblems", () => {
  const valid = () => JSON.parse(raw);

  it("rejects an unknown guard type", () => {
    const config = valid();
    config.repos.target.guard = "public";
    expect(configProblems(config)).not.toEqual([]);
  });

  it("rejects a checklist section the tickets don't have", () => {
    const config = valid();
    config.repos.target.tickets.checklist = "Done when";
    expect(configProblems(config)).toEqual(['target: checklist "Done when" is not one of its sections']);
  });

  it("rejects an unknown field, so typos can't slip through", () => {
    const config = valid();
    config.repos.target.chek = "npm test";
    expect(configProblems(config)).not.toEqual([]);
  });

  it.each(["docs/evidence", "private/../docs", "../elsewhere", "/tmp/evidence"])(
    "rejects evidence stored outside private/: %s",
    (evidence) => {
      expect(configProblems({ ...valid(), evidence })).not.toEqual([]);
    },
  );

  it("accepts a third repo added as one entry", () => {
    const config = valid();
    config.repos.other = { ...config.repos.target, github: "AJBeumer/other-app", path: "../other-app" };
    expect(configProblems(config)).toEqual([]);
  });
});

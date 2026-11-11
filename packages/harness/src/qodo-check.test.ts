import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CheckDeps,
  collectRules,
  collectSkills,
  compareRelations,
  compareRules,
  compareSkills,
  fetchRelations,
  highestSnapshotDir,
  loadSnapshot,
  normalizeRule,
  normalizeSkill,
  runCheck,
} from "./qodo-check.ts";

const rule = (overrides: Partial<Parameters<typeof normalizeRule>[0]> = {}) => ({
  ruleId: 1,
  name: "Validate the whole request before any state-changing write",
  content: "Check every route.",
  state: "active",
  scopes: ["/ajbeumer/faultforge-target/"],
  severity: "error",
  ...overrides,
});

const skill = (overrides: Partial<Parameters<typeof normalizeSkill>[0]> = {}) => ({
  id: 390398,
  state: "active",
  ...overrides,
});

let dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qodo-check-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function writeSnapshot(
  configDir: string,
  version: string,
  data: { rules?: unknown[]; skills?: unknown[]; relations?: unknown[] } = {},
) {
  const dir = join(configDir, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "rules.json"),
    JSON.stringify({ page: 1, totalCount: (data.rules ?? []).length, rules: data.rules ?? [] }),
  );
  writeFileSync(
    join(dir, "review-skills-list.json"),
    JSON.stringify({ page: 1, pages: 1, size: 50, total: (data.skills ?? []).length, items: data.skills ?? [] }),
  );
  writeFileSync(
    join(dir, "cross-repo-relations.json"),
    JSON.stringify({ relations: data.relations ?? [], repo: "AJBeumer/faultforge-target", shallow: false }),
  );
}

describe("compareRules", () => {
  it("matches when live and snapshot are identical", () => {
    expect(compareRules([rule()].map(normalizeRule), [rule()].map(normalizeRule))).toEqual([]);
  });

  it("reports a changed rule's content", () => {
    const live = [rule({ content: "Check every route, including cancellation." })].map(normalizeRule);
    const snapshot = [rule()].map(normalizeRule);
    expect(compareRules(live, snapshot)).toEqual([
      expect.objectContaining({ type: "changed", field: "content", id: "1" }),
    ]);
  });

  it("reports an extra active rule as new", () => {
    const live = [rule(), rule({ ruleId: 2, name: "A new rule" })].map(normalizeRule);
    const snapshot = [rule()].map(normalizeRule);
    expect(compareRules(live, snapshot)).toEqual([
      expect.objectContaining({ type: "new", id: "2", name: "A new rule" }),
    ]);
  });

  it("reports a rule missing from the live answer", () => {
    const live = [rule()].map(normalizeRule);
    const snapshot = [rule(), rule({ ruleId: 2, name: "A retired rule" })].map(normalizeRule);
    expect(compareRules(live, snapshot)).toEqual([
      expect.objectContaining({ type: "missing", id: "2", name: "A retired rule" }),
    ]);
  });

  it("reports an inactive rule turned active as a changed state", () => {
    const live = [rule({ state: "active" })].map(normalizeRule);
    const snapshot = [rule({ state: "inactive" })].map(normalizeRule);
    expect(compareRules(live, snapshot)).toEqual([
      expect.objectContaining({ type: "changed", field: "state", before: "inactive", after: "active" }),
    ]);
  });

  it("ignores scope order", () => {
    const live = [rule({ scopes: ["/b/", "/a/"] })].map(normalizeRule);
    const snapshot = [rule({ scopes: ["/a/", "/b/"] })].map(normalizeRule);
    expect(compareRules(live, snapshot)).toEqual([]);
  });
});

describe("compareSkills", () => {
  it("matches identical skills", () => {
    expect(compareSkills([skill()].map(normalizeSkill), [skill()].map(normalizeSkill))).toEqual([]);
  });

  it("reports a skill's state change", () => {
    const live = [skill({ state: "inactive" })].map(normalizeSkill);
    const snapshot = [skill({ state: "active" })].map(normalizeSkill);
    expect(compareSkills(live, snapshot)).toEqual([
      expect.objectContaining({ kind: "skill", type: "changed", field: "state" }),
    ]);
  });
});

describe("compareRelations", () => {
  it("matches when both are empty", () => {
    expect(compareRelations([], [])).toEqual([]);
  });

  it("reports a relationship that appeared on the target", () => {
    const relation = {
      relationType: "pipeline",
      status: "completed",
      sourceId: "a",
      targetId: "b",
      oneLiner: "adversarial review harness",
      createdAt: "2026-11-02T15:01:20Z",
    };
    const differences = compareRelations([relation], []);
    expect(differences).toEqual([expect.objectContaining({ kind: "relation", type: "new" })]);
  });
});

describe("collectRules", () => {
  it("follows every page until totalCount is reached", async () => {
    const pageOne = [rule({ ruleId: 1 }), rule({ ruleId: 2 })];
    const pageTwo = [rule({ ruleId: 3 })];
    const calls: number[] = [];
    const call = async ({ page }: { page: number }) => {
      calls.push(page);
      return page === 1 ? { page: 1, totalCount: 3, rules: pageOne } : { page: 2, totalCount: 3, rules: pageTwo };
    };
    const rules = await collectRules(call);
    expect(rules).toHaveLength(3);
    expect(calls).toEqual([1, 2]);
  });
});

describe("collectSkills", () => {
  it("follows every page until `pages` is reached", async () => {
    const call = async ({ page }: { page: number }) =>
      page === 1 ? { page: 1, pages: 2, items: [skill({ id: 1 })] } : { page: 2, pages: 2, items: [skill({ id: 2 })] };
    expect(await collectSkills(call)).toHaveLength(2);
  });
});

describe("fetchRelations", () => {
  it("passes the target repo and provider", async () => {
    let seen: { repo: string; provider: string } | null = null;
    const relations = await fetchRelations(async (args) => {
      seen = args;
      return { relations: [] };
    }, "AJBeumer/faultforge-target");
    expect(seen).toEqual({ repo: "AJBeumer/faultforge-target", provider: "github" });
    expect(relations).toEqual([]);
  });
});

describe("highestSnapshotDir / loadSnapshot", () => {
  it("picks the highest-numbered qodo-vN folder", () => {
    const configDir = tmpDir();
    writeSnapshot(configDir, "qodo-v1", { rules: [rule({ ruleId: 1, name: "old" })] });
    writeSnapshot(configDir, "qodo-v10", { rules: [rule({ ruleId: 1, name: "new" })] });
    writeSnapshot(configDir, "qodo-v2", { rules: [rule({ ruleId: 1, name: "mid" })] });
    expect(highestSnapshotDir(configDir)).toBe(join(configDir, "qodo-v10"));
    expect(loadSnapshot(configDir).rules[0]).toEqual(expect.objectContaining({ name: "new" }));
  });

  it("throws when there is no snapshot", () => {
    expect(() => highestSnapshotDir(tmpDir())).toThrow(/no qodo-vN snapshot/);
  });
});

describe("runCheck", () => {
  function deps(configDir: string, overrides: Partial<CheckDeps> = {}): CheckDeps {
    const raw: Record<string, unknown> = {};
    return {
      call: async (tool) => {
        if (tool === "rules-list") return { page: 1, totalCount: 1, rules: [rule()] };
        if (tool === "review-skills-list") return { page: 1, pages: 1, items: [skill()] };
        if (tool === "cross-repo-relations") return { relations: [] };
        throw new Error(`unexpected tool ${tool}`);
      },
      saveRaw: (name, data) => {
        raw[name] = data;
      },
      snapshotDir: configDir,
      targetRepo: "AJBeumer/faultforge-target",
      ...overrides,
    };
  }

  it("exits 0 when everything matches", async () => {
    const configDir = tmpDir();
    writeSnapshot(configDir, "qodo-v1", { rules: [rule()], skills: [skill()], relations: [] });
    const result = await runCheck(deps(configDir));
    expect(result).toEqual(expect.objectContaining({ exitCode: 0, differences: [] }));
  });

  it("exits 2 when there is no snapshot", async () => {
    const result = await runCheck(deps(tmpDir()));
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/snapshot/);
  });

  it("exits 2 when the API call fails", async () => {
    const configDir = tmpDir();
    writeSnapshot(configDir, "qodo-v1", { rules: [rule()], skills: [skill()], relations: [] });
    const result = await runCheck(
      deps(configDir, {
        call: async () => {
          throw new Error("MT-UPSTREAM-DOWN");
        },
      }),
    );
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/MT-UPSTREAM-DOWN/);
  });

  it("exits 1 and saves the raw answers before reporting a difference", async () => {
    const configDir = tmpDir();
    writeSnapshot(configDir, "qodo-v1", { rules: [rule()], skills: [skill()], relations: [] });
    const saved: Record<string, unknown> = {};
    const result = await runCheck(
      deps(configDir, {
        call: async (tool) => {
          if (tool === "rules-list") return { page: 1, totalCount: 1, rules: [rule({ content: "different" })] };
          if (tool === "review-skills-list") return { page: 1, pages: 1, items: [skill()] };
          return { relations: [] };
        },
        saveRaw: (name, data) => {
          saved[name] = data;
        },
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.differences).toEqual([expect.objectContaining({ type: "changed", field: "content" })]);
    expect(saved).toHaveProperty("rules.raw.json");
    expect(saved).toHaveProperty("review-skills.raw.json");
    expect(saved).toHaveProperty("cross-repo-relations.raw.json");
  });

  it("exits 1 when a relationship has appeared on the target", async () => {
    const configDir = tmpDir();
    writeSnapshot(configDir, "qodo-v1", { rules: [rule()], skills: [skill()], relations: [] });
    const result = await runCheck(
      deps(configDir, {
        call: async (tool) => {
          if (tool === "rules-list") return { page: 1, totalCount: 1, rules: [rule()] };
          if (tool === "review-skills-list") return { page: 1, pages: 1, items: [skill()] };
          return { relations: [{ relationType: "pipeline", status: "completed" }] };
        },
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.differences).toEqual([expect.objectContaining({ kind: "relation", type: "new" })]);
  });
});

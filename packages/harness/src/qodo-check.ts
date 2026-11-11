/**
 * Compares Qodo's live configuration (rules, review skills, the target's relationships) with the
 * highest-numbered snapshot in private storage, so a drift like the one on 9-11 November (CLAUDE.md
 * derived 15 unreviewed rules within a minute of two merges) is caught the next time anything runs,
 * not days later by hand.
 *
 *   npm run qodo:check
 *
 * Read-only throughout (`QodoApi`'s allow-list). Needs `QODO_API_KEY` or `QODO_KEY_FILE`. The live
 * answers are saved raw, before comparing, under `raw-artifacts/qodo-state/<timestamp>/`.
 *
 * Exit codes: 0 Qodo matches the snapshot; 1 a difference was found, each one printed (new, missing or
 * changed, with its id, name and field); 2 unable to check (no key, no snapshot, an API or parse error).
 * The key is never printed.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type FactoryConfig, loadFactory, repoConfig } from "./factory-config.ts";
import { QodoApi } from "./qodo-api.ts";
import { privateDir } from "./templates.ts";

/** The fields the ticket says must match; everything else (timestamps, counters, extraction
 * metadata, examples, source details) is ignored. */
export interface RuleFacts {
  id: string;
  name: string;
  content: string;
  state: string;
  scopes: string[];
  severity: string;
}

export interface SkillFacts {
  id: string;
  state: string;
}

type Kind = "rule" | "skill" | "relation";

export type Difference =
  | { kind: Kind; type: "new"; id: string; name: string }
  | { kind: Kind; type: "missing"; id: string; name: string }
  | { kind: Kind; type: "changed"; id: string; name: string; field: string; before: unknown; after: unknown };

/** A rule as `rules-list` or a snapshot's `rules.json` returns it, reduced to the fields that matter. */
export function normalizeRule(rule: {
  ruleId: number | string;
  name: string;
  content: string;
  state: string;
  scopes: string[];
  severity: string;
}): RuleFacts {
  return {
    id: String(rule.ruleId),
    name: rule.name,
    content: rule.content,
    state: rule.state,
    scopes: [...rule.scopes].sort(),
    severity: rule.severity,
  };
}

/** A review skill as `review-skills-list` or a snapshot's `review-skills-list.json` returns it. */
export function normalizeSkill(skill: { id: number | string; state: string }): SkillFacts {
  return { id: String(skill.id), state: skill.state };
}

/** Differences between two normalized lists, keyed by `id`: present in only one side ("new" when only
 * in `live`, "missing" when only in `snapshot`), or one "changed" entry per field that differs. */
function diffById<T extends { id: string; name?: string }>(
  kind: Kind,
  live: T[],
  snapshot: T[],
  fields: (keyof T)[],
  label: (item: T) => string,
): Difference[] {
  const liveById = new Map(live.map((item) => [item.id, item]));
  const snapshotById = new Map(snapshot.map((item) => [item.id, item]));
  const differences: Difference[] = [];
  for (const [id, item] of liveById) {
    if (!snapshotById.has(id)) differences.push({ kind, type: "new", id, name: label(item) });
  }
  for (const [id, item] of snapshotById) {
    if (!liveById.has(id)) differences.push({ kind, type: "missing", id, name: label(item) });
  }
  for (const [id, liveItem] of liveById) {
    const snapshotItem = snapshotById.get(id);
    if (!snapshotItem) continue;
    for (const field of fields) {
      const before = snapshotItem[field];
      const after = liveItem[field];
      const changed =
        Array.isArray(before) && Array.isArray(after) ? before.join("␟") !== after.join("␟") : before !== after;
      if (changed)
        differences.push({ kind, type: "changed", id, name: label(liveItem), field: String(field), before, after });
    }
  }
  return differences;
}

export function compareRules(live: RuleFacts[], snapshot: RuleFacts[]): Difference[] {
  return diffById("rule", live, snapshot, ["name", "content", "state", "scopes", "severity"], (r) => r.name);
}

export function compareSkills(live: SkillFacts[], snapshot: SkillFacts[]): Difference[] {
  return diffById("skill", live, snapshot, ["state"], (s) => s.id);
}

/** A relation's stable identity, with volatile fields (timestamps, the human-written one-liner, the
 * discovery source) dropped: what's left is what "no relationship on the target" is actually about. */
function relationKey(relation: Record<string, unknown>): string {
  const { relationType, status, sourceId, targetId } = relation as Record<string, unknown>;
  return JSON.stringify({ relationType, status, sourceId, targetId });
}

/** Differences in the target's relationships: any entry on either side not matched on the other,
 * by its stable fields. The snapshot's own `relations` is empty, so a non-empty `live` always means
 * "a relationship appeared" - the thing `CLAUDE.md` requires checking before every case. */
export function compareRelations(live: unknown[], snapshot: unknown[]): Difference[] {
  const label = (r: Record<string, unknown>) => String(r.relationType ?? r.oneLiner ?? "relation");
  const withKey = (list: unknown[]) =>
    list.map((r) => ({ id: relationKey(r as Record<string, unknown>), name: label(r as Record<string, unknown>) }));
  return diffById("relation", withKey(live), withKey(snapshot), [], (r) => r.name);
}

export interface RulesPage {
  page: number;
  totalCount: number;
  rules: Parameters<typeof normalizeRule>[0][];
}

export interface SkillsPage {
  page: number;
  pages: number;
  items: Parameters<typeof normalizeSkill>[0][];
}

export interface RelationsPage {
  relations: unknown[];
}

/** Every stop that keeps a loop from running forever against a tool that never reaches its own total. */
const MAX_PAGES = 1000;

/** Every rule `rules-list` holds, following `page` until `totalCount` rules have been collected. */
export async function collectRules(call: (args: { page: number }) => Promise<RulesPage>): Promise<RulesPage["rules"]> {
  const all: RulesPage["rules"] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await call({ page });
    all.push(...result.rules);
    if (all.length >= result.totalCount || result.rules.length === 0) return all;
  }
  throw new Error(`rules-list did not finish within ${MAX_PAGES} pages`);
}

/** Every review skill `review-skills-list` holds, following `page` until its own `pages` total is reached. */
export async function collectSkills(
  call: (args: { page: number }) => Promise<SkillsPage>,
): Promise<SkillsPage["items"]> {
  const all: SkillsPage["items"] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await call({ page });
    all.push(...result.items);
    if (page >= result.pages || result.items.length === 0) return all;
  }
  throw new Error(`review-skills-list did not finish within ${MAX_PAGES} pages`);
}

/** The target's relationships, read in one call: `cross-repo-relations` isn't paginated. */
export async function fetchRelations(
  call: (args: { repo: string; provider: string }) => Promise<RelationsPage>,
  repo: string,
): Promise<unknown[]> {
  const result = await call({ repo, provider: "github" });
  return result.relations;
}

export interface Snapshot {
  version: string;
  rules: RuleFacts[];
  skills: SkillFacts[];
  relations: unknown[];
}

/** The `qodo-vN` folder with the highest `N` under `configDir`. Throws if there is none: a missing
 * snapshot must stop the check, never compare against nothing and call that a match. */
export function highestSnapshotDir(configDir: string): string {
  let entries: string[];
  try {
    entries = readdirSync(configDir);
  } catch (error) {
    throw new Error(`cannot read the snapshot folder ${configDir}: ${(error as Error).message}`);
  }
  const versions = entries
    .map((name) => ({ name, match: /^qodo-v(\d+)$/.exec(name) }))
    .filter((e): e is { name: string; match: RegExpExecArray } => e.match !== null)
    .map((e) => ({ name: e.name, n: Number(e.match[1]) }))
    .sort((a, b) => b.n - a.n);
  const highest = versions[0];
  if (!highest) throw new Error(`no qodo-vN snapshot found under ${configDir}`);
  return join(configDir, highest.name);
}

/** The highest-numbered snapshot, reduced to the facts the check compares against. */
export function loadSnapshot(configDir: string): Snapshot {
  const dir = highestSnapshotDir(configDir);
  const read = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));
  const rules = (read("rules.json").rules as Parameters<typeof normalizeRule>[0][]).map(normalizeRule);
  const skills = (read("review-skills-list.json").items as Parameters<typeof normalizeSkill>[0][]).map(normalizeSkill);
  const relations = read("cross-repo-relations.json").relations as unknown[];
  return { version: basename(dir), rules, skills, relations };
}

export interface CheckDeps {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** Saves one live answer before it's compared, so it's kept even if the comparison never runs. */
  saveRaw(name: string, data: unknown): void;
  snapshotDir: string;
  targetRepo: string;
}

export interface CheckResult {
  exitCode: 0 | 1 | 2;
  differences: Difference[];
  message: string;
  snapshotVersion?: string;
}

/** Reads Qodo's live rules, review skills and the target's relationships, saves each raw, and compares
 * them with the highest-numbered snapshot. Never throws: every way this can't be decided (no snapshot,
 * no key, a failed or unparsable API call) comes back as `exitCode: 2` instead. */
export async function runCheck(deps: CheckDeps): Promise<CheckResult> {
  let snapshot: Snapshot;
  try {
    snapshot = loadSnapshot(deps.snapshotDir);
  } catch (error) {
    return { exitCode: 2, differences: [], message: `could not read the snapshot: ${(error as Error).message}` };
  }

  let liveRules: RuleFacts[];
  let liveSkills: SkillFacts[];
  let liveRelations: unknown[];
  try {
    const rawRules = await collectRules((args) => deps.call("rules-list", args) as Promise<RulesPage>);
    deps.saveRaw("rules.raw.json", rawRules);
    liveRules = rawRules.map(normalizeRule);

    const rawSkills = await collectSkills((args) => deps.call("review-skills-list", args) as Promise<SkillsPage>);
    deps.saveRaw("review-skills.raw.json", rawSkills);
    liveSkills = rawSkills.map(normalizeSkill);

    liveRelations = await fetchRelations(
      (args) => deps.call("cross-repo-relations", args) as Promise<RelationsPage>,
      deps.targetRepo,
    );
    deps.saveRaw("cross-repo-relations.raw.json", liveRelations);
  } catch (error) {
    return { exitCode: 2, differences: [], message: `could not read Qodo's live state: ${(error as Error).message}` };
  }

  const differences = [
    ...compareRules(liveRules, snapshot.rules),
    ...compareSkills(liveSkills, snapshot.skills),
    ...compareRelations(liveRelations, snapshot.relations),
  ];
  if (differences.length) {
    return {
      exitCode: 1,
      differences,
      snapshotVersion: snapshot.version,
      message: `${differences.length} difference(s) from ${snapshot.version}`,
    };
  }
  return { exitCode: 0, differences: [], snapshotVersion: snapshot.version, message: `matches ${snapshot.version}` };
}

/** One printable line per difference, with its id, name and (for a change) the field. */
export function formatDifference(d: Difference): string {
  if (d.type === "new") return `new ${d.kind}: ${d.name} (${d.id})`;
  if (d.type === "missing") return `missing ${d.kind}: ${d.name} (${d.id})`;
  return `changed ${d.kind} ${d.name} (${d.id}): ${d.field} was ${JSON.stringify(d.before)}, is now ${JSON.stringify(d.after)}`;
}

/**
 * Runs the live check against the current snapshot, with the evidence folder resolved from `factory`:
 * what `factory:tick` calls before the hook self-test, and what `main` below calls for the CLI. Never
 * throws: a key that can't be read is reported the same way as any other `exitCode: 2`.
 */
export async function checkLiveQodoConfig(factory: FactoryConfig): Promise<CheckResult & { evidenceDir: string }> {
  const targetRepo = repoConfig(factory, "target").github;
  const evidence = resolve(fileURLToPath(new URL("../../..", import.meta.url)), factory.evidence);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(evidence, "qodo-state", stamp);
  mkdirSync(dir, { recursive: true });

  let api: QodoApi;
  try {
    api = new QodoApi();
  } catch (error) {
    return { exitCode: 2, differences: [], message: (error as Error).message, evidenceDir: dir };
  }

  const result = await runCheck({
    call: (tool, args) => api.call(tool, args),
    saveRaw: (name, data) => writeFileSync(join(dir, name), `${JSON.stringify(data, null, 2)}\n`),
    snapshotDir: join(privateDir(), "config"),
    targetRepo,
  });
  return { ...result, evidenceDir: dir };
}

async function main() {
  const factory = loadFactory();
  const result = await checkLiveQodoConfig(factory);
  const dir = result.evidenceDir;

  if (result.exitCode === 2) {
    console.error(`qodo:check could not run: ${result.message}`);
  } else if (result.exitCode === 1) {
    console.log(`qodo:check found ${result.differences.length} difference(s) from ${result.snapshotVersion}:`);
    for (const d of result.differences) console.log(`- ${formatDifference(d)}`);
  } else {
    console.log(`qodo:check: ${result.message}`);
  }
  console.log(`Saved in ${dir}`);
  process.exit(result.exitCode);
}

// Run only when called as a script, not when the tests import it.
// Exit codes: 0 match, 1 difference(s) found (printed), 2 unable to check (no key, no snapshot, API/parse error).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main().catch((error: unknown) => {
    console.error(`qodo:check could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}

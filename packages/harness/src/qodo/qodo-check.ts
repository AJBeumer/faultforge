/**
 * Compares Qodo's live configuration (rules, review skills, the target's relationships, and every repository's
 * root and Wiki `.pr_agent.toml`, `pr-agent-files.ts`) with the highest-numbered snapshot in private storage.
 * Qodo can derive new rules on its own within a minute of a merge, so drift must be caught the next time
 * anything runs, not later by hand.
 *
 *   npm run qodo:check
 *
 * Read-only throughout (`QodoApi`'s allow-list; GitHub reads and a Wiki clone into a temporary folder). Needs
 * `QODO_API_KEY` or `QODO_KEY_FILE`. The live answers are saved raw, before comparing, under
 * `raw-artifacts/qodo-state/<timestamp>/`, the files as `pr-agent-files.json` (`text: null` when absent).
 *
 * Exit codes: 0 Qodo matches the snapshot; 1 a difference was found, each one printed (new, missing or
 * changed, with its id, name and field); 2 unable to check (no key, no snapshot or no file record in it, an
 * API or parse error, a Wiki or file that can't be read).
 * The key is never printed.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type FactoryConfig, loadFactory, repoConfig } from "../shared/factory-config.ts";
import { ROOT } from "../shared/paths.ts";
import { privateDir } from "../shared/templates.ts";
import { comparePrAgentFiles, type PrAgentFile, readPrAgentFiles, realReaders } from "./pr-agent-files.ts";
import { QodoApi } from "./qodo-api.ts";

/** The fields that must match. Timestamps, counters, examples and source details change on their own. */
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

type Kind = "rule" | "skill" | "relation" | "file";

export type Difference =
  | { kind: Kind; type: "new"; id: string; name: string }
  | { kind: Kind; type: "missing"; id: string; name: string }
  | { kind: Kind; type: "changed"; id: string; name: string; field: string; before: unknown; after: unknown };

/** A rule from `rules-list` or a snapshot's `rules.json`, reduced to the fields that matter. */
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

export function normalizeSkill(skill: { id: number | string; state: string }): SkillFacts {
  return { id: String(skill.id), state: skill.state };
}

/** "new" when only live, "missing" when only in the snapshot, and one "changed" per field that differs. */
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

/** A plain object's field, or `undefined`: a malformed entry has no fields, and is no reason to throw. */
function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * A relation's stable fields only: timestamps, the one-liner and the discovery source change on their own.
 * A malformed entry is keyed by its JSON text, so it shows as a difference instead of crashing the check.
 */
function relationKey(relation: unknown): string {
  if (!relation || typeof relation !== "object" || Array.isArray(relation))
    return `malformed:${JSON.stringify(relation)}`;
  const { relationType, status, sourceId, targetId } = relation as Record<string, unknown>;
  return JSON.stringify({ relationType, status, sourceId, targetId });
}

/** The snapshot holds no relations, so any live one is a relationship that appeared, which a case must not run with. */
export function compareRelations(live: unknown[], snapshot: unknown[]): Difference[] {
  const label = (r: unknown) => String(field(r, "relationType") ?? field(r, "oneLiner") ?? "relation");
  const withKey = (list: unknown[]) => list.map((r) => ({ id: relationKey(r), name: label(r) }));
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

/** Stops a loop against a tool that never reaches its own total. */
const MAX_PAGES = 1000;

export async function collectRules(call: (args: { page: number }) => Promise<RulesPage>): Promise<RulesPage["rules"]> {
  const all: RulesPage["rules"] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await call({ page });
    all.push(...result.rules);
    if (all.length >= result.totalCount || result.rules.length === 0) return all;
  }
  throw new Error(`rules-list did not finish within ${MAX_PAGES} pages`);
}

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

/** One call: `cross-repo-relations` isn't paginated. */
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
  prAgentFiles: PrAgentFile[];
}

/** The highest `qodo-vN` folder. Throws if there is none: comparing against nothing would read as a match. */
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

export function loadSnapshot(configDir: string): Snapshot {
  const dir = highestSnapshotDir(configDir);
  const read = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));
  const rules = (read("rules.json").rules as Parameters<typeof normalizeRule>[0][]).map(normalizeRule);
  const skills = (read("review-skills-list.json").items as Parameters<typeof normalizeSkill>[0][]).map(normalizeSkill);
  const relations = read("cross-repo-relations.json").relations as unknown[];
  // Without a record of the .pr_agent.toml files, a Wiki page could not be told from the snapshot's state.
  const prAgentFiles = read("pr-agent-files.json").files;
  if (!Array.isArray(prAgentFiles)) throw new Error(`${basename(dir)}/pr-agent-files.json holds no list of files`);
  return { version: basename(dir), rules, skills, relations, prAgentFiles };
}

export interface CheckDeps {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** Called as each page arrives, so a later failure never costs a page that already came back. */
  saveRaw(name: string, data: unknown): void;
  snapshotDir: string;
  targetRepo: string;
  /** Every repository's root and Wiki `.pr_agent.toml` (`pr-agent-files.ts`); throws when one can't be read. */
  prAgentFiles(): PrAgentFile[];
}

export interface CheckResult {
  exitCode: 0 | 1 | 2;
  differences: Difference[];
  message: string;
  snapshotVersion?: string;
}

/** Saves each page's answer, or its error, before the next page is asked for and before anything is compared. */
function paged<T>(deps: CheckDeps, tool: string, prefix: string): (args: Record<string, unknown>) => Promise<T> {
  return async (args) => {
    const page = typeof args.page === "number" ? args.page : 1;
    try {
      const result = (await deps.call(tool, args)) as T;
      deps.saveRaw(`${prefix}.page${page}.raw.json`, result);
      return result;
    } catch (error) {
      deps.saveRaw(`${prefix}.page${page}.error.json`, { error: (error as Error).message });
      throw error;
    }
  };
}

/** Never throws: anything that keeps the check from being decided comes back as `exitCode: 2`. */
export async function runCheck(deps: CheckDeps): Promise<CheckResult> {
  let snapshot: Snapshot;
  try {
    snapshot = loadSnapshot(deps.snapshotDir);
  } catch (error) {
    return { exitCode: 2, differences: [], message: `could not read the snapshot: ${(error as Error).message}` };
  }

  try {
    const rawRules = await collectRules(paged<RulesPage>(deps, "rules-list", "rules"));
    const rawSkills = await collectSkills(paged<SkillsPage>(deps, "review-skills-list", "review-skills"));
    const liveRelations = await fetchRelations(
      paged<RelationsPage>(deps, "cross-repo-relations", "cross-repo-relations"),
      deps.targetRepo,
    );
    const files = deps.prAgentFiles();
    deps.saveRaw("pr-agent-files.json", { files });

    const differences = [
      ...compareRules(rawRules.map(normalizeRule), snapshot.rules),
      ...compareSkills(rawSkills.map(normalizeSkill), snapshot.skills),
      ...compareRelations(liveRelations, snapshot.relations),
      ...comparePrAgentFiles(files, snapshot.prAgentFiles),
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
  } catch (error) {
    return { exitCode: 2, differences: [], message: `could not read Qodo's live state: ${(error as Error).message}` };
  }
}

/**
 * Full detail, for the owner's console only. A rule's name or content can hold private text, so a ticket
 * comment or the run log uses `summarizeDifference`.
 */
export function formatDifference(d: Difference): string {
  if (d.type === "new") return `new ${d.kind}: ${d.name} (${d.id})`;
  if (d.type === "missing") return `missing ${d.kind}: ${d.name} (${d.id})`;
  return `changed ${d.kind} ${d.name} (${d.id}): ${d.field} was ${JSON.stringify(d.before)}, is now ${JSON.stringify(d.after)}`;
}

/** No names or values, so safe for a public ticket: a fixed word list can't catch free-form private rule text. */
export function summarizeDifference(d: Difference): string {
  if (d.type === "changed") return `changed ${d.kind} ${d.id} (${d.field})`;
  return `${d.type} ${d.kind} ${d.id}`;
}

export interface CheckRoots {
  /** Where `private/config/qodo-vN` lives; defaults to `privateDir()`'s `config` folder. */
  snapshotDir?: string;
  /** The folder `qodo-state/<timestamp>` is created under; defaults to this checkout's evidence root. */
  evidenceRoot?: string;
}

/**
 * Used by `factory:tick` with its worktree's roots, and by the CLI with the defaults. Never throws: anything
 * that keeps the check from being decided, setup included, comes back as `exitCode: 2`.
 */
export async function checkLiveQodoConfig(
  factory: FactoryConfig,
  roots: CheckRoots = {},
): Promise<CheckResult & { evidenceDir: string | null }> {
  let dir: string | null = null;
  try {
    const targetRepo = repoConfig(factory, "target").github;
    const evidenceRoot = roots.evidenceRoot ?? resolve(ROOT, factory.evidence);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    dir = join(evidenceRoot, "qodo-state", stamp);
    mkdirSync(dir, { recursive: true });

    const api = new QodoApi();
    const saveRaw = (name: string, data: unknown) => {
      const at = dir as string;
      writeFileSync(join(at, name), `${JSON.stringify(data, null, 2)}\n`);
    };
    const result = await runCheck({
      call: async (tool, args) => {
        const page = typeof args.page === "number" ? args.page : 1;
        try {
          return await api.call(tool, args);
        } finally {
          // The exact wire answer too: a reply that fails to parse, or a recovered failure, is otherwise lost.
          if (api.lastRecoveredRaw.length) {
            saveRaw(`${tool}.page${page}.recovered.raw.json`, api.lastRecoveredRaw);
          }
          if (api.lastRaw) saveRaw(`${tool}.page${page}.wire.raw.json`, api.lastRaw);
        }
      },
      saveRaw,
      snapshotDir: roots.snapshotDir ?? join(privateDir(), "config"),
      targetRepo,
      prAgentFiles: () =>
        readPrAgentFiles(
          Object.values(factory.repos).map((r) => r.github),
          realReaders,
        ),
    });
    return { ...result, evidenceDir: dir };
  } catch (error) {
    return { exitCode: 2, differences: [], message: (error as Error).message, evidenceDir: dir };
  }
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
  if (dir) console.log(`Saved in ${dir}`);
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

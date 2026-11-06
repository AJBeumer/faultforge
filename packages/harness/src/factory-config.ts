import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

export interface RepoConfig {
  github: string;
  path: string;
  guard: "lab" | "reviewed";
  check: string;
  start: { command: string; port: number; health: string } | null;
  tickets: { sections: string[]; checklist: string };
  board: boolean;
}

export interface FactoryConfig {
  evidence: string;
  repos: Record<string, RepoConfig>;
}

const root = join(import.meta.dirname, "../../..");
const schema = JSON.parse(readFileSync(join(root, "schemas/factory.v1.json"), "utf8"));
const schemaCheck = new Ajv2020({ allErrors: true }).compile(schema);

/** Problems with a factory configuration, or an empty list. */
export function configProblems(config: unknown): string[] {
  if (!schemaCheck(config)) {
    return (schemaCheck.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
  }
  const { repos } = config as FactoryConfig;
  const problems: string[] = [];
  for (const [key, repo] of Object.entries(repos)) {
    if (!repo.tickets.sections.includes(repo.tickets.checklist)) {
      problems.push(`${key}: checklist "${repo.tickets.checklist}" is not one of its sections`);
    }
  }
  return problems;
}

/** The checked-in `factory.json`, or `FAULTFORGE_CONFIG` if set (tests use that). */
export function loadFactory(path = process.env.FAULTFORGE_CONFIG ?? join(root, "factory.json")): FactoryConfig {
  const config = JSON.parse(readFileSync(path, "utf8"));
  const problems = configProblems(config);
  if (problems.length) throw new Error(`Invalid factory config ${path}:\n${problems.join("\n")}`);
  return config;
}

/** One repo's settings by its key in `factory.json`. */
export function repoConfig(config: FactoryConfig, key: string): RepoConfig {
  const repo = config.repos[key];
  if (!repo) throw new Error(`No repo "${key}" in factory.json. Known: ${Object.keys(config.repos).join(", ")}`);
  return repo;
}

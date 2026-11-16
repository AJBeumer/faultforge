import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";

export interface RepoConfig {
  github: string;
  path: string;
  guard: "lab" | "reviewed";
  check: string;
  /** Regular expression for test files and test data, matched against repo-relative paths (`revert:check`). */
  tests: string;
  start: { command: string; port: number; health: string } | null;
  tickets: { sections: string[]; checklist: string };
  board: boolean;
  /** The files that decide whether the check passes, compared after every factory run
   * (`factory-check-files.ts`): `files` compared whole, `scripts` (`package.json` files) by their `scripts` field
   * only. Regular expressions on repo-relative paths. Required by the schema; optional here so a test's made-up
   * config needs none (a run without it fails closed). */
  checkFiles?: { files: string; scripts: string };
}

export interface FactoryConfig {
  evidence: string;
  /** The hosts a CI run's agent may reach, through the runner's proxy (`factory-sandbox.ts`). Required by
   * the schema; optional here so a test's made-up config needs none. */
  network?: { allow: string[] };
  repos: Record<string, RepoConfig>;
}

const root = join(import.meta.dirname, "../../../..");
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
    try {
      new RegExp(repo.tests);
    } catch {
      problems.push(`${key}: tests "${repo.tests}" is not a valid regular expression`);
    }
    for (const [name, pattern] of Object.entries(repo.checkFiles ?? {})) {
      try {
        new RegExp(pattern, "i");
      } catch {
        problems.push(`${key}: checkFiles.${name} "${pattern}" is not a valid regular expression`);
      }
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

export function repoConfig(config: FactoryConfig, key: string): RepoConfig {
  const repo = config.repos[key];
  if (!repo) throw new Error(`No repo "${key}" in factory.json. Known: ${Object.keys(config.repos).join(", ")}`);
  return repo;
}

/**
 * Applies one sabotage template to a clean target checkout and validates it.
 *
 *   npm run inject -- --template idempotency-guard-bypass-v1 --target ../faultforge-target --case FF-0001
 *
 * The mutation is committed on its own branch in the target repository (not pushed).
 * It counts as validated only if the hidden proof test passes on the base commit, fails
 * on the variant, and the variant still typechecks. Ledger entry, audit event and raw
 * artefacts go to private storage, which never enters the target repository.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { templateTelltales } from "./neutral.ts";
import { templateDir as findTemplateDir, kindTermsOf, privateDir } from "./templates.ts";

interface Template {
  id: string;
  invariantId: string;
  defectClass: string;
  summary: string;
  file: string;
  find: string;
  replace: string;
  proofTest: string;
  match?: { kindTerms?: string[] };
  publish: { branch: string; commitMessage: string };
}

type Outcome = "pass" | "fail";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PRIVATE_DIR = privateDir();
const TOOL = `faultforge-harness@${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version}`;

const { values: args } = parseArgs({
  options: {
    template: { type: "string" },
    target: { type: "string" },
    case: { type: "string" },
  },
});
if (!args.template || !args.target || !args.case) {
  fail("usage: npm run inject -- --template <id> --target <path> --case <FF-NNNN>");
}

const caseId = args.case;
const targetDir = resolve(args.target);
// Unreleased templates live in private storage; only adjudicated ones are copied to templates/seed.
const templateDir = findTemplateDir(args.template);
if (!templateDir) fail(`template ${args.template} not found in private/templates or templates/seed`);
const template: Template = JSON.parse(readFileSync(join(templateDir, "template.json"), "utf8"));
// Everything the template would put in front of the reviewer must read as an ordinary change: the branch
// name and commit message, and the code it looks for and writes.
const giveaways = templateTelltales(template);
if (giveaways.length) fail(`the template gives the case away (${giveaways.join("; ")})`);
// The terms the match rule's third criterion looks for, declared here before any case runs the template.
try {
  kindTermsOf(template, `${templateDir}/template.json`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const proofPath = join(templateDir, template.proofTest);
const artefactDir = join(PRIVATE_DIR, "raw-artifacts", caseId);
const ledgerPath = join(PRIVATE_DIR, "ground-truth.jsonl");

// Preconditions: fresh case id, clean target, branch name free.
if (readJsonl(ledgerPath).some((entry) => entry.caseId === caseId)) {
  fail(`${caseId} is already in the ledger`);
}
if (git("status", "--porcelain")) fail(`target has uncommitted changes: ${targetDir}`);
const baseBranch = git("rev-parse", "--abbrev-ref", "HEAD");
const baseCommit = git("rev-parse", "HEAD");
if (run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${template.publish.branch}`], targetDir).status === 0) {
  fail(`branch ${template.publish.branch} already exists in the target`);
}

mkdirSync(artefactDir, { recursive: true });

log(`base ${baseBranch} @ ${baseCommit.slice(0, 7)}`);
const proofOnBase = runProof("base");
if (proofOnBase !== "pass") fail("proof test fails on the base commit; it cannot prove anything");

let injectionCommit: string | undefined;
let injectedLines: [number, number];
let typecheck: Outcome;
let publicTests: Outcome;
let proofOnVariant: Outcome;

git("switch", "--quiet", "-c", template.publish.branch);
try {
  injectedLines = applyMutation();
  writeFileSync(join(artefactDir, "variant.diff"), git("diff"));

  typecheck = runStep("typecheck", process.execPath, [
    join(targetDir, "node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.json",
    "--noEmit",
  ]);
  publicTests = runStep("public-tests", process.execPath, [join(targetDir, "node_modules/vitest/vitest.mjs"), "run"]);
  proofOnVariant = runProof("variant");

  if (typecheck !== "pass") throw new Error("variant does not typecheck");
  if (proofOnVariant !== "fail") throw new Error("proof test still passes on the variant; mutation not validated");

  git("commit", "--quiet", "--all", "-m", template.publish.commitMessage);
  injectionCommit = git("rev-parse", "HEAD");
} finally {
  if (!injectionCommit) {
    git("reset", "--quiet", "--hard");
    git("switch", "--quiet", baseBranch);
    git("branch", "--quiet", "-D", template.publish.branch);
  } else {
    git("switch", "--quiet", baseBranch);
  }
}
if (!injectionCommit) fail("variant was not committed");

copyFileSync(proofPath, join(artefactDir, template.proofTest));
const proofHash = sha256(readFileSync(proofPath));
const createdAt = new Date().toISOString();

const entry = {
  caseId,
  kind: "sabotage",
  templateId: template.id,
  invariantId: template.invariantId,
  defectClass: template.defectClass,
  targetRepo: git("remote", "get-url", "origin"),
  targetCommit: baseCommit,
  injectionCommit,
  branch: template.publish.branch,
  injectedFile: template.file,
  injectedLines,
  proofTest: `${template.id}/${template.proofTest}@sha256:${proofHash}`,
  validation: { proofOnBase, proofOnVariant, typecheck, publicTests },
  validated: true,
  createdAt,
};
appendJsonl(ledgerPath, entry);
appendJsonl(join(PRIVATE_DIR, "audit-events.jsonl"), {
  eventId: randomUUID(),
  type: "sabotage.injected",
  at: createdAt,
  caseId,
  tool: TOOL,
  environment: `${platform()}-${arch()}-node${process.versions.node}`,
  inputHash: sha256(readFileSync(join(templateDir, "template.json")) + proofHash + baseCommit),
});

log(`validated: proof passes on base, fails on variant; public tests ${publicTests}`);
log(
  `${caseId} -> branch ${template.publish.branch} @ ${injectionCommit.slice(0, 7)}, ${template.file}:${injectedLines.join("-")}`,
);
log(`ledger: ${ledgerPath}`);

/** Replaces the template's `find` text, which must occur exactly once. Returns the new lines. */
function applyMutation(): [number, number] {
  const path = join(targetDir, template.file);
  const source = readFileSync(path, "utf8");
  const at = source.indexOf(template.find);
  if (at === -1 || source.indexOf(template.find, at + 1) !== -1) {
    throw new Error(`find text must occur exactly once in ${template.file}`);
  }
  writeFileSync(path, source.slice(0, at) + template.replace + source.slice(at + template.find.length));
  const start = source.slice(0, at).split("\n").length;
  const lineCount = template.replace.replace(/\n$/, "").split("\n").length;
  return [start, start + lineCount - 1];
}

function runProof(stage: "base" | "variant"): Outcome {
  const outcome = runStep(
    `proof-${stage}`,
    process.execPath,
    [
      join(ROOT, "node_modules/vitest/vitest.mjs"),
      "run",
      "--root",
      dirname(proofPath),
      "--config",
      join(ROOT, "vitest.proof.config.ts"),
    ],
    ROOT,
    { FAULTFORGE_TARGET_DIR: targetDir },
  );
  log(`proof on ${stage}: ${outcome}`);
  return outcome;
}

/** Runs a command, stores its output as an artefact, and reports pass or fail. */
function runStep(
  name: string,
  cmd: string,
  cmdArgs: string[],
  cwd = targetDir,
  env: Record<string, string> = {},
): Outcome {
  const result = run(cmd, cmdArgs, cwd, env);
  writeFileSync(
    join(artefactDir, `${name}.log`),
    `$ ${cmdArgs.join(" ")}\nexit ${result.status}\n\n${result.stdout}${result.stderr}`,
  );
  return result.status === 0 ? "pass" : "fail";
}

function run(cmd: string, cmdArgs: string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env, NO_COLOR: "1" },
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function git(...gitArgs: string[]): string {
  const result = run("git", gitArgs, targetDir);
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendJsonl(path: string, value: object) {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function log(message: string) {
  console.log(`[inject] ${message}`);
}

function fail(message: string): never {
  console.error(`[inject] ${message}`);
  process.exit(1);
}

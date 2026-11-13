/**
 * Applies one sabotage template to a clean target checkout and validates it.
 *
 *   npm run inject -- --template idempotency-guard-bypass-v1 --target ../faultforge-target --case FF-0001
 *
 * The mutation is committed on its own branch in the target repository (not pushed). It counts as
 * validated only if the proof test of the template's `invariantId`, and of every `alsoBreaks` entry,
 * passes on the base commit and fails on the variant with a test that ran and failed (a proof that
 * fails to load proves nothing), and the variant still typechecks. Ledger entry,
 * audit event and raw artefacts go to private storage, which never enters the target repository.
 *
 *   npm run inject -- --template idempotency-guard-bypass-v1 --target ../faultforge-target --validate-only
 *
 * `--validate-only` checks the template against the schema and runs the same proofs and typecheck, without planting
 * anything: the target checkout ends exactly as it started (same HEAD, same branch, clean tree), and
 * nothing is written to private storage. No `--case` is needed or used.
 *
 * Exit codes: 0 the template is valid and (in `--validate-only`) every proof passed on the base commit
 * and failed on the variant, or (otherwise) the case was planted and recorded; 1 a refusal or a failed
 * validation, printed on stderr.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { baseTreeTelltales } from "./base-tree.ts";
import { deriveBranchName, gitBranchExistence } from "./branch-name.ts";
import { ledgerProblemsWithHistory } from "./ledger-check.ts";
import { telltales, templateTelltales } from "./neutral.ts";
import { ROOT } from "./paths.ts";
import { type Outcome, outcomeOf, proofOutcomeOf, readVitestReport, stepLogText } from "./run-outcome.ts";
import { templateDir as findTemplateDir, kindTermsOf, privateDir, templateProblems } from "./templates.ts";

interface AlsoBreaks {
  invariantId: string;
  proofTest: string;
}

interface Template {
  id: string;
  kind: "bug" | "control";
  summary: string;
  file: string;
  find: string;
  replace: string;
  publish: { branch: string; commitMessage: string };
  ticket: { title: string; what: string; criteria: string[] };
  invariantId?: string;
  defectClass?: string;
  proofTest?: string;
  match?: { kindTerms?: string[] };
  alsoBreaks?: AlsoBreaks[];
}

interface Proof {
  invariantId: string;
  proofTest: string;
}

const PRIVATE_DIR = privateDir();
const TOOL = `faultforge-harness@${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version}`;

const { values: args } = parseArgs({
  options: {
    template: { type: "string" },
    target: { type: "string" },
    case: { type: "string" },
    "validate-only": { type: "boolean" },
  },
});
const validateOnly = args["validate-only"] ?? false;
if (!args.template || !args.target || (!validateOnly && !args.case)) {
  fail(
    "usage: npm run inject -- --template <id> --target <path> --case <FF-NNNN>\n" +
      "   or: npm run inject -- --template <id> --target <path> --validate-only",
  );
}

const caseId = args.case;
// A case id becomes a folder name and a permanent answer-key line, so a typo must stop here (#193).
if (!validateOnly && !/^FF-\d{4}$/.test(caseId ?? "")) fail(`--case must look like FF-NNNN, not ${caseId}`);
const targetDir = resolve(args.target);
// Unreleased templates live in private storage; only adjudicated ones are copied to templates/seed.
const foundTemplateDir = findTemplateDir(args.template);
if (!foundTemplateDir) fail(`template ${args.template} not found in private/templates or templates/seed`);
const templateDir: string = foundTemplateDir;
const template: Template = JSON.parse(readFileSync(join(templateDir, "template.json"), "utf8"));

// Checked before anything else: a template that fails the schema is refused without planting anything.
const schemaProblems = templateProblems(template);
if (schemaProblems.length) {
  fail(`template ${args.template} fails the schema:\n${schemaProblems.map((p) => `  ${p}`).join("\n")}`);
}
// Everything the template would put in front of the reviewer must read as an ordinary change: the branch
// name and commit message, the code it looks for and writes, and its target ticket.
const giveaways = templateTelltales(template);
if (giveaways.length) fail(`the template gives the case away (${giveaways.join("; ")})`);

// The terms the match rule's third criterion looks for, declared here before any case runs the template.
// Only a bug template carries one: a control has no injected problem to describe.
if (template.kind === "bug") {
  try {
    kindTermsOf(template, `${templateDir}/template.json`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

// Every proof the variant must break: the template's own invariant, plus whatever it breaks as collateral.
const proofs: Proof[] =
  template.kind === "bug"
    ? [
        { invariantId: template.invariantId as string, proofTest: template.proofTest as string },
        ...(template.alsoBreaks ?? []),
      ]
    : [];

const artefactDir = validateOnly
  ? mkdtempSync(join(tmpdir(), "faultforge-validate-"))
  : join(PRIVATE_DIR, "raw-artifacts", caseId as string);
// Registered as soon as the folder exists, so a refusal on any later precondition still cleans it up:
// nothing from --validate-only may survive, not even a scratch folder outside private storage.
if (validateOnly) process.on("exit", () => rmSync(artefactDir, { recursive: true, force: true }));
const ledgerPath = join(PRIVATE_DIR, "ground-truth.jsonl");

if (!validateOnly) {
  // History too: an entry is only appended to a file whose history is still append-only (#224).
  const ledgerIssues = ledgerProblemsWithHistory([ledgerPath, join(PRIVATE_DIR, "audit-events.jsonl")]);
  if (ledgerIssues.length) fail(`the answer key or audit log has problems: ${ledgerIssues.join("; ")}`);
  if (readJsonl(ledgerPath).some((entry) => entry.caseId === caseId)) fail(`${caseId} is already in the ledger`);
}
if (git("status", "--porcelain")) fail(`target has uncommitted changes: ${targetDir}`);
const baseBranch = git("rev-parse", "--abbrev-ref", "HEAD");
const baseCommit = git("rev-parse", "HEAD");
// The checkout is put back on this branch at the end, so it must be one (#193): from a detached HEAD the
// switch back would fail after the commit, leaving a planted commit with no answer-key line.
if (baseBranch === "HEAD") fail(`target is on a detached HEAD: switch to main first (${targetDir})`);
// The reviewer reads the whole tree, not only the diff (#224, audit H-4).
const baseGiveaways = baseTreeTelltales(targetDir, baseCommit);
if (baseGiveaways.length) fail(`the target's base commit gives the lab away: ${baseGiveaways.join("; ")}`);
// A case is planted on the published main, never on top of an earlier case branch (#193). Read from the
// local copy of origin/main: no network, so fetch first if main moved.
if (!validateOnly) {
  const originMain = run("git", ["rev-parse", "--verify", "--quiet", "origin/main"], targetDir).stdout.trim();
  if (baseCommit !== originMain) {
    fail(
      `target HEAD ${baseCommit.slice(0, 7)} is not origin/main (${originMain.slice(0, 7) || "missing"}): switch to main and pull first`,
    );
  }
}
// --validate-only derives nothing and never asks origin: its temporary branch is deleted before the run
// ends, so it only needs the one local check it always had, to avoid `git switch -c` failing outright.
const actualBranch = validateOnly
  ? template.publish.branch
  : deriveBranchName(template.publish.branch, gitBranchExistence(targetDir));
if (validateOnly && gitBranchExistence(targetDir).existsLocally(actualBranch)) {
  fail(`branch ${actualBranch} already exists in the target`);
}
if (!validateOnly) {
  const derivedGiveaways = telltales(actualBranch);
  if (derivedGiveaways.length) fail(`the derived branch name gives the case away (${derivedGiveaways.join("; ")})`);
}

if (!validateOnly) mkdirSync(artefactDir, { recursive: true });

log(`base ${baseBranch} @ ${baseCommit.slice(0, 7)}`);

// Indexed by position in `proofs`, never by invariantId: alsoBreaks may name the same invariant twice
// (collateral the template didn't separate), and keying by invariantId would let a later proof's result
// silently overwrite an earlier one's.
const proofsOnBase: Outcome[] = proofs.map((proof, i) => runProof("base", proof, i));
const notRunOnBase = proofs.filter((_, i) => proofsOnBase[i] === "not_run").map((p) => p.invariantId);
if (notRunOnBase.length) {
  fail(
    `proof test did not finish, or ran no test, on the base commit, so it cannot prove anything: ${notRunOnBase.join(", ")}`,
  );
}
const failingOnBase = proofs.filter((_, i) => proofsOnBase[i] === "fail").map((p) => p.invariantId);
if (failingOnBase.length) {
  fail(`proof test fails on the base commit, so it cannot prove anything: ${failingOnBase.join(", ")}`);
}

let injectionCommit: string | undefined;
let injectedLines: [number, number] = [0, 0];
let typecheck: Outcome = "pass";
let publicTests: Outcome = "pass";
let proofsOnVariant: Outcome[] = [];
let failure: string | undefined;

git("switch", "--quiet", "-c", actualBranch);
try {
  injectedLines = applyMutation();
  if (!validateOnly) writeFileSync(join(artefactDir, "variant.diff"), git("diff"));

  // The typecheck runs in --validate-only too: a variant that doesn't compile proves nothing (#217).
  typecheck = runStep("typecheck", process.execPath, [
    join(targetDir, "node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.json",
    "--noEmit",
  ]);
  if (!validateOnly) {
    publicTests = runStep("public-tests", process.execPath, [join(targetDir, "node_modules/vitest/vitest.mjs"), "run"]);
  }
  proofsOnVariant = proofs.map((proof, i) => runProof("variant", proof, i));

  const notRunOnVariant = proofs.filter((_, i) => proofsOnVariant[i] === "not_run").map((p) => p.invariantId);
  const stillPassing = proofs.filter((_, i) => proofsOnVariant[i] === "pass").map((p) => p.invariantId);
  if (notRunOnVariant.length) {
    failure = `proof test did not finish, failed only to load, or ran no test on the variant, so the mutation is not validated: ${notRunOnVariant.join(", ")}`;
  } else if (stillPassing.length) {
    failure = `proof test still passes on the variant, so the mutation is not validated: ${stillPassing.join(", ")}`;
  } else if (typecheck === "not_run") {
    failure = "typecheck did not finish, so the mutation is not validated";
  } else if (typecheck === "fail") {
    failure = "variant does not typecheck";
  } else if (!validateOnly && publicTests === "not_run") {
    // Missing for either kind: a bug case with no evidence on its public tests is as unvalidated as
    // one with a failing proof, and a control has no proof at all to fall back on.
    failure = "public tests did not finish, so the mutation is not validated";
  } else if (!validateOnly && template.kind === "control" && publicTests === "fail") {
    // A control has no proof to anchor it as harmless; the public tests are what stand in for one.
    failure = "control variant fails the public tests, so it is not a clean control";
  }

  if (!failure && !validateOnly) {
    git("commit", "--quiet", "--all", "-m", template.publish.commitMessage);
    injectionCommit = git("rev-parse", "HEAD");
  }
} finally {
  // --validate-only always leaves the checkout exactly as it found it; a real run keeps the committed
  // variant only when validation succeeded.
  if (validateOnly || !injectionCommit) {
    git("reset", "--quiet", "--hard");
    git("switch", "--quiet", baseBranch);
    git("branch", "--quiet", "-D", actualBranch);
  } else {
    git("switch", "--quiet", baseBranch);
  }
}
if (failure) fail(failure);

if (validateOnly) {
  log(
    `validated: every proof passes on base and fails on variant (${proofs.map((p) => p.invariantId).join(", ") || "none"})`,
  );
  process.exit(0);
}
if (!injectionCommit) fail("variant was not committed");

for (const proof of proofs) {
  const dest = join(artefactDir, proof.proofTest);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(templateDir, proof.proofTest), dest);
}
const createdAt = new Date().toISOString();

const entry =
  template.kind === "bug"
    ? {
        caseId,
        kind: "sabotage",
        templateId: template.id,
        invariantId: template.invariantId,
        defectClass: template.defectClass,
        targetRepo: git("remote", "get-url", "origin"),
        targetCommit: baseCommit,
        injectionCommit,
        branch: actualBranch,
        injectedFile: template.file,
        injectedLines,
        validation: {
          proofs: proofs.map((proof, i) => ({
            invariantId: proof.invariantId,
            proofTest: `${template.id}/${proof.proofTest}@sha256:${sha256(readFileSync(join(templateDir, proof.proofTest)))}`,
            proofOnBase: proofsOnBase[i],
            proofOnVariant: proofsOnVariant[i],
          })),
          typecheck,
          publicTests,
        },
        validated: true,
        createdAt,
      }
    : {
        caseId,
        kind: "control",
        templateId: template.id,
        targetRepo: git("remote", "get-url", "origin"),
        targetCommit: baseCommit,
        injectionCommit,
        branch: actualBranch,
        injectedFile: template.file,
        injectedLines,
        validation: { typecheck, publicTests },
        validated: true,
        createdAt,
      };
appendJsonl(ledgerPath, entry);
appendJsonl(join(PRIVATE_DIR, "audit-events.jsonl"), {
  eventId: randomUUID(),
  type: template.kind === "bug" ? "sabotage.injected" : "control.injected",
  at: createdAt,
  caseId,
  branch: actualBranch,
  tool: TOOL,
  environment: `${platform()}-${arch()}-node${process.versions.node}`,
  inputHash: sha256(
    readFileSync(join(templateDir, "template.json")) +
      proofs.map((p) => sha256(readFileSync(join(templateDir, p.proofTest)))).join("") +
      baseCommit,
  ),
});

log(`validated: proof(s) pass on base, fail on variant; public tests ${publicTests}`);
log(
  `${caseId} -> branch ${actualBranch} @ ${injectionCommit.slice(0, 7)}, ${template.file}:${injectedLines.join("-")}`,
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

/** Runs one proof test in a scratch folder holding only that file, so proof file names never collide. */
function runProof(stage: "base" | "variant", proof: Proof, index: number): Outcome {
  const scratch = mkdtempSync(join(tmpdir(), "faultforge-proof-"));
  try {
    const dest = join(scratch, proof.proofTest);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(templateDir, proof.proofTest), dest);
    // The JSON report says whether a test ran and failed; an exit code alone can't tell that from a
    // proof that failed to load (#217).
    const report = join(scratch, "proof-report.json");
    const outcome = runStep(
      // Numbered: two proofs may share an invariant id, and each keeps its own log (#193).
      `proof-${stage}-${index + 1}-${proof.invariantId}`,
      process.execPath,
      [
        join(ROOT, "node_modules/vitest/vitest.mjs"),
        "run",
        "--root",
        scratch,
        "--config",
        join(ROOT, "vitest.proof.config.ts"),
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${report}`,
      ],
      ROOT,
      { FAULTFORGE_TARGET_DIR: targetDir },
      (result) => proofOutcomeOf(result, readVitestReport(report)),
    );
    log(`proof ${proof.invariantId} on ${stage}: ${outcome}`);
    return outcome;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Runs a command, stores its output as an artefact, and reports the outcome: "not_run", never
 * "fail", when the command hit its time limit or could not be spawned at all, since no test result
 * was ever produced for either.
 */
function runStep(
  name: string,
  cmd: string,
  cmdArgs: string[],
  cwd = targetDir,
  env: Record<string, string> = {},
  judge: (result: ReturnType<typeof run>) => Outcome = outcomeOf,
): Outcome {
  const result = run(cmd, cmdArgs, cwd, env);
  const outcome = judge(result);
  writeFileSync(join(artefactDir, `${name}.log`), stepLogText(cmdArgs, result, outcome));
  return outcome;
}

function run(cmd: string, cmdArgs: string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env, NO_COLOR: "1" },
    timeout: 120_000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
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

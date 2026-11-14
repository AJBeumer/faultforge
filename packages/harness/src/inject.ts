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
 * validation, printed on stderr; 2 it stopped on an unexpected error (a git call failed, a mutation didn't
 * apply), printed on stderr. Whatever was done before the error stays done: check the target's branches.
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { baseTreeProblems } from "./base-tree.ts";
import { deriveBranchName, gitBranchExistence } from "./branch-name.ts";
import { guardProblem } from "./guard-install.ts";
import { appendJsonl, git as gitIn, log, readJsonl, run, runProof, runStep } from "./inject-run.ts";
import {
  applyMutation,
  loadTemplate,
  type Proof,
  proofsOf,
  type Template,
  templateRefusal,
} from "./inject-template.ts";
import { ledgerProblemsWithHistory } from "./ledger-check.ts";
import { telltales } from "./neutral.ts";
import { ROOT } from "./paths.ts";
import { sha256, TOOL } from "./provenance.ts";
import type { Outcome } from "./run-outcome.ts";
import { templateDir as findTemplateDir, privateDir } from "./templates.ts";

// An unexpected error is exit 2, never 1: 1 is a refusal or a failed validation (AUD-N3). An unknown option
// is a usage error, so it is 1 like the usage message below.
process.on("uncaughtException", (error) => {
  const usage = (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ?? false;
  // The stack for an unexpected error, so the failing step can be found (Qodo on PR 260).
  console.error(
    usage ? `refused: ${error.message}` : `inject stopped on an unexpected error: ${error.stack ?? error.message}`,
  );
  process.exit(usage ? 1 : 2);
});

const PRIVATE_DIR = privateDir();

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
const template: Template = loadTemplate(templateDir);

const refusal = templateRefusal(template, args.template as string, templateDir);
if (refusal) fail(refusal);

const proofs: Proof[] = proofsOf(template);

const artefactDir = validateOnly
  ? mkdtempSync(join(tmpdir(), "faultforge-validate-"))
  : join(PRIVATE_DIR, "raw-artifacts", caseId as string);
// Registered as soon as the folder exists, so a refusal on any later precondition still cleans it up:
// nothing from --validate-only may survive, not even a scratch folder outside private storage.
if (validateOnly) process.on("exit", () => rmSync(artefactDir, { recursive: true, force: true }));
const ledgerPath = join(PRIVATE_DIR, "ground-truth.jsonl");
const places = { targetDir, artefactDir, templateDir };
const git = (...gitArgs: string[]) => gitIn(targetDir, ...gitArgs);

// History too, in --validate-only as well: nothing is planted next to a broken answer key (#224, Qodo on PR 232).
const ledgerIssues = ledgerProblemsWithHistory([ledgerPath, join(PRIVATE_DIR, "audit-events.jsonl")]);
if (ledgerIssues.length) fail(`the answer key or audit log has problems: ${ledgerIssues.join("; ")}`);
if (!validateOnly && readJsonl(ledgerPath).some((entry) => entry.caseId === caseId)) {
  fail(`${caseId} is already in the ledger`);
}
if (git("status", "--porcelain")) fail(`target has uncommitted changes: ${targetDir}`);
const baseBranch = git("rev-parse", "--abbrev-ref", "HEAD");
const baseCommit = git("rev-parse", "HEAD");
// The checkout is put back on this branch at the end, so it must be one (#193): from a detached HEAD the
// switch back would fail after the commit, leaving a planted commit with no answer-key line.
if (baseBranch === "HEAD") fail(`target is on a detached HEAD: switch to main first (${targetDir})`);
// The reviewer reads the whole tree, not only the diff (#224, audit H-4).
const baseGiveaways = baseTreeProblems(targetDir, baseCommit);
if (baseGiveaways.length) fail(`the target's base commit can't be used: ${baseGiveaways.join("; ")}`);
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
// A real case commits in the target, so git's own guard must be there to check that commit (#242).
if (!validateOnly) {
  const unguarded = guardProblem(targetDir);
  if (unguarded) fail(`${unguarded}. Run npm run guard:install first.`);
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
const proofsOnBase: Outcome[] = proofs.map((proof, i) => runProof(places, "base", proof, i));
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
  injectedLines = applyMutation(targetDir, template);
  const diff = run("git", ["diff"], targetDir); // untrimmed (N-14); a failed or cut-off diff stops the run (Qodo on PR 233)
  if (diff.status !== 0 || diff.error) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  if (!validateOnly) writeFileSync(join(artefactDir, "variant.diff"), diff.stdout);

  // The typecheck runs in --validate-only too: a variant that doesn't compile proves nothing (#217).
  typecheck = runStep(places, "typecheck", process.execPath, [
    join(targetDir, "node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.json",
    "--noEmit",
  ]);
  if (!validateOnly) {
    publicTests = runStep(places, "public-tests", process.execPath, [
      join(targetDir, "node_modules/vitest/vitest.mjs"),
      "run",
    ]);
  }
  proofsOnVariant = proofs.map((proof, i) => runProof(places, "variant", proof, i));

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

function fail(message: string): never {
  console.error(`[inject] ${message}`);
  process.exit(1);
}

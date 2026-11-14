/**
 * The body of `npm run inject` (see `inject.ts` for the command and its exit codes), as a function the tests
 * drive with fakes (AUD-M6): every git call, proof run, typecheck and test run is passed in, and private
 * storage is a folder. `run` returns 0, 1 for a refusal or a failed validation, or 2 for anything
 * unexpected; it never exits the process.
 */
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { baseTreeProblems } from "./base-tree.ts";
import { type BranchExistence, deriveBranchName, gitBranchExistence } from "./branch-name.ts";
import { errorText } from "./error-text.ts";
import { guardProblem } from "./guard-install.ts";
import { git as gitIn, readJsonl, run as runCommand, runProof, runStep, type StepPlaces } from "./inject-run.ts";
import {
  applyMutation,
  loadTemplate,
  loadTemplates,
  type Proof,
  proofCorpus,
  proofsOf,
  type Template,
  templateRefusal,
  variantFailure,
} from "./inject-template.ts";
import { appendAnswerKeyEntry, appendEvent, eventProblems } from "./ledger-append.ts";
import { ledgerProblemsWithHistory } from "./ledger-check.ts";
import { injectionInputHash } from "./ledger-hashes.ts";
import { telltales } from "./neutral.ts";
import { ROOT } from "./paths.ts";
import { sha256, TOOL } from "./provenance.ts";
import type { Outcome } from "./run-outcome.ts";
import { templateDir as findTemplateDir, privateDir } from "./templates.ts";

export interface InjectArgs {
  template: string;
  target: string;
  caseId?: string;
  validateOnly: boolean;
}

/** Everything `run` touches outside its own folders. `liveInjectDeps` gives the real ones. */
export interface InjectDeps {
  privateDir: string;
  findTemplateDir: (id: string) => string | undefined;
  /** Every proof a control's variant must pass, and the templates left out of the corpus (by id, with why). */
  corpus: () => Proof[];
  corpusSkipped?: () => string[];
  /** Every template, for the benchmark v2 rules that compare a template with the others. */
  allTemplates: () => Template[];
  ledgerProblems: (paths: string[]) => string[];
  git: (targetDir: string, ...args: string[]) => string;
  /** The local `origin/main`, or "" when there is none. */
  originMain: (targetDir: string) => string;
  branches: (targetDir: string) => BranchExistence;
  baseTreeProblems: (targetDir: string, commit: string) => string[];
  /** Why the target lacks git's own guard (`guard-install.ts`), or undefined when it has it. */
  guardProblem: (targetDir: string) => string | undefined;
  diff: (targetDir: string) => { status: number | null; stdout: string; stderr: string; error?: Error };
  runProof: (places: StepPlaces, stage: "base" | "variant", proof: Proof, index: number) => Outcome;
  runStep: (places: StepPlaces, name: string, cmd: string, args: string[]) => Outcome;
  now: () => string;
  log: (line: string) => void;
  error: (line: string) => void;
}

/** A refusal or a failed validation: exit 1, its message on stderr. */
class Refusal extends Error {}

const refuse = (message: string): never => {
  throw new Refusal(message);
};

export { variantFailure };

/** The real git, proofs, typecheck and tests, and private storage as `privateDir()` names it. */
export function liveInjectDeps(env: NodeJS.ProcessEnv = process.env): InjectDeps {
  const skipped: string[] = [];
  return {
    privateDir: privateDir(env),
    findTemplateDir: (id) => findTemplateDir(id, env),
    corpus: () =>
      proofCorpus([join(privateDir(env), "templates"), join(ROOT, "templates", "seed")], (id, why) => {
        skipped.push(`${id}: ${why}`);
        console.error(`[inject] corpus: skipped ${id}, because ${why}`);
      }),
    corpusSkipped: () => skipped,
    allTemplates: () => loadTemplates([join(privateDir(env), "templates"), join(ROOT, "templates", "seed")]),
    ledgerProblems: ledgerProblemsWithHistory,
    git: gitIn,
    originMain: (dir) => runCommand("git", ["rev-parse", "--verify", "--quiet", "origin/main"], dir).stdout.trim(),
    branches: gitBranchExistence,
    baseTreeProblems,
    guardProblem,
    diff: (dir) => runCommand("git", ["diff"], dir),
    runProof,
    runStep: (places, name, cmd, args) => runStep(places, name, cmd, args),
    now: () => new Date().toISOString(),
    log: (line) => console.log(`[inject] ${line}`),
    error: (line) => console.error(`[inject] ${line}`),
  };
}

/** Runs one injection (or `--validate-only`) and returns its exit code. */
export function run(args: InjectArgs, deps: InjectDeps): number {
  let scratch: string | undefined;
  try {
    return inject(args, deps, (dir) => {
      scratch = dir;
    });
  } catch (e) {
    if (e instanceof Refusal) {
      deps.error(e.message);
      return 1;
    }
    deps.error(`stopped on an unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : errorText(e)}`);
    return 2;
  } finally {
    // Nothing from --validate-only survives, not even its scratch folder.
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

function inject(args: InjectArgs, deps: InjectDeps, scratchMade: (dir: string) => void): number {
  const { validateOnly } = args;
  const caseId = args.caseId;
  // A case id becomes a folder name and a permanent answer-key line, so a typo must stop here (#193).
  if (!validateOnly && !/^FF-\d{4}$/.test(caseId ?? "")) refuse(`--case must look like FF-NNNN, not ${caseId}`);
  const targetDir = resolve(args.target);
  const templateDir =
    deps.findTemplateDir(args.template) ??
    refuse(`template ${args.template} not found in private/templates or templates/seed`);
  const template: Template = loadTemplate(templateDir);
  const refusal = templateRefusal(template, args.template, templateDir, deps.allTemplates());
  if (refusal) refuse(refusal);

  // A bug's own proofs must break; a control must break none of the corpus (AUD-M8).
  const proofs: Proof[] = template.kind === "bug" ? proofsOf(template) : deps.corpus();
  if (template.kind === "control" && !proofs.length)
    refuse("no bug template's proof was found to check the control against");

  const ledgerPath = join(deps.privateDir, "ground-truth.jsonl");
  const auditPath = join(deps.privateDir, "audit-events.jsonl");
  // History too, in --validate-only as well: nothing is planted next to a broken answer key (#224).
  const ledgerIssues = deps.ledgerProblems([ledgerPath, auditPath]);
  if (ledgerIssues.length) refuse(`the answer key or audit log has problems: ${ledgerIssues.join("; ")}`);
  if (!validateOnly && readJsonl(ledgerPath).some((entry) => entry.caseId === caseId)) {
    refuse(`${caseId} is already in the ledger`);
  }
  const git = (...gitArgs: string[]) => deps.git(targetDir, ...gitArgs);
  if (git("status", "--porcelain")) refuse(`target has uncommitted changes: ${targetDir}`);
  const baseBranch = git("rev-parse", "--abbrev-ref", "HEAD");
  const baseCommit = git("rev-parse", "HEAD");
  // The checkout is put back on this branch at the end, so it must be one (#193).
  if (baseBranch === "HEAD") refuse(`target is on a detached HEAD: switch to main first (${targetDir})`);
  // The reviewer reads the whole tree, not only the diff (#224, audit H-4).
  const baseGiveaways = deps.baseTreeProblems(targetDir, baseCommit);
  if (baseGiveaways.length) refuse(`the target's base commit can't be used: ${baseGiveaways.join("; ")}`);
  // A case is planted on the published main, never on top of an earlier case branch (#193).
  if (!validateOnly) {
    const originMain = deps.originMain(targetDir);
    if (baseCommit !== originMain) {
      refuse(
        `target HEAD ${baseCommit.slice(0, 7)} is not origin/main (${originMain.slice(0, 7) || "missing"}): switch to main and pull first`,
      );
    }
  }
  // A real case commits in the target, so git's own guard must be there to check that commit (#242).
  if (!validateOnly) {
    const unguarded = deps.guardProblem(targetDir);
    if (unguarded) refuse(`${unguarded}. Run npm run guard:install first.`);
  }
  const existence = deps.branches(targetDir);
  const branch = validateOnly ? template.publish.branch : deriveBranchName(template.publish.branch, existence);
  if (validateOnly && existence.existsLocally(branch)) refuse(`branch ${branch} already exists in the target`);
  if (!validateOnly) {
    const derivedGiveaways = telltales(branch);
    if (derivedGiveaways.length) refuse(`the derived branch name gives the case away (${derivedGiveaways.join("; ")})`);
  }

  let artefactDir: string;
  if (validateOnly) {
    artefactDir = mkdtempSync(join(tmpdir(), "faultforge-validate-"));
    scratchMade(artefactDir);
  } else {
    artefactDir = join(deps.privateDir, "raw-artifacts", caseId as string);
    mkdirSync(artefactDir, { recursive: true });
  }
  const places: StepPlaces = { targetDir, artefactDir, templateDir };
  deps.log(`base ${baseBranch} @ ${baseCommit.slice(0, 7)}`);

  // Indexed by position, never by invariantId: alsoBreaks may name the same invariant twice.
  const proofsOnBase = proofs.map((proof, i) => deps.runProof(places, "base", proof, i));
  const notRunOnBase = proofs.filter((_, i) => proofsOnBase[i] === "not_run").map((p) => p.invariantId);
  if (notRunOnBase.length) {
    refuse(
      `proof test did not finish, or ran no test, on the base commit, so it cannot prove anything: ${notRunOnBase.join(", ")}`,
    );
  }
  const failingOnBase = proofs.filter((_, i) => proofsOnBase[i] === "fail").map((p) => p.invariantId);
  if (failingOnBase.length) {
    refuse(`proof test fails on the base commit, so it cannot prove anything: ${failingOnBase.join(", ")}`);
  }

  let injectionCommit: string | undefined;
  let injectedLines: [number, number] = [0, 0];
  let typecheck: Outcome = "pass";
  let publicTests: Outcome = "pass";
  let proofsOnVariant: Outcome[] = [];
  let failure: string | undefined;

  git("switch", "--quiet", "-c", branch);
  try {
    injectedLines = applyMutation(targetDir, template);
    const diff = deps.diff(targetDir); // untrimmed (N-14); a failed diff stops the run (Qodo on PR 233)
    if (diff.status !== 0 || diff.error) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
    if (!validateOnly) writeFileSync(join(artefactDir, "variant.diff"), diff.stdout);

    // With the target's own test config when it has one: that is what its own check compiles (AUD-N7).
    const tsconfig = existsSync(join(targetDir, "tsconfig.test.json")) ? "tsconfig.test.json" : "tsconfig.json";
    typecheck = deps.runStep(places, "typecheck", process.execPath, [
      join(targetDir, "node_modules/typescript/bin/tsc"),
      "-p",
      tsconfig,
      "--noEmit",
    ]);
    if (!validateOnly) {
      publicTests = deps.runStep(places, "public-tests", process.execPath, [
        join(targetDir, "node_modules/vitest/vitest.mjs"),
        "run",
      ]);
    }
    proofsOnVariant = proofs.map((proof, i) => deps.runProof(places, "variant", proof, i));
    failure = variantFailure(template, proofs, proofsOnVariant, typecheck, validateOnly ? "pass" : publicTests);

    if (!failure && !validateOnly) {
      git("commit", "--quiet", "--all", "-m", template.publish.commitMessage);
      injectionCommit = git("rev-parse", "HEAD");
    }
  } finally {
    // --validate-only always leaves the checkout as it found it; a real run keeps the variant only when valid.
    if (validateOnly || !injectionCommit) {
      git("reset", "--quiet", "--hard");
      git("switch", "--quiet", baseBranch);
      git("branch", "--quiet", "-D", branch);
    } else {
      git("switch", "--quiet", baseBranch);
    }
  }
  if (failure) refuse(failure);
  if (validateOnly) {
    deps.log(
      template.kind === "bug"
        ? `validated: every proof passes on base and fails on variant (${proofs.map((p) => p.invariantId).join(", ")})`
        : `validated: the control passes all ${proofs.length} proofs in the corpus, on base and on variant`,
    );
    return 0;
  }
  if (!injectionCommit) throw new Error("variant was not committed");

  const ownProofs = template.kind === "bug" ? proofs : [];
  for (const proof of ownProofs) {
    const dest = join(artefactDir, proof.proofTest);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(templateDir, proof.proofTest), dest);
  }
  const createdAt = deps.now();
  // The fields both kinds share, in the order the answer key has always had them.
  const located = {
    targetRepo: git("remote", "get-url", "origin"),
    targetCommit: baseCommit,
    injectionCommit,
    branch,
    injectedFile: template.file,
    injectedLines,
  };
  const entry =
    template.kind === "bug"
      ? {
          caseId,
          kind: "sabotage",
          templateId: template.id,
          invariantId: template.invariantId,
          defectClass: template.defectClass,
          ...located,
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
          ...located,
          // Every corpus proof by file and hash, so the control's validation can be checked later (Qodo on PR 271).
          validation: {
            typecheck,
            publicTests,
            corpus: proofs.map((proof, i) => ({
              invariantId: proof.invariantId,
              proofTest: `${basename(proof.dir ?? templateDir)}/${proof.proofTest}@sha256:${sha256(readFileSync(join(proof.dir ?? templateDir, proof.proofTest)))}`,
              proofOnBase: proofsOnBase[i],
              proofOnVariant: proofsOnVariant[i],
            })),
            // Any template left out of the corpus, said on the record, never silently (Qodo on PR 274).
            ...(deps.corpusSkipped?.().length ? { corpusSkipped: deps.corpusSkipped() } : {}),
          },
          validated: true,
          createdAt,
        };
  const event = {
    eventId: randomUUID(),
    type: template.kind === "bug" ? "sabotage.injected" : "control.injected",
    at: createdAt,
    caseId,
    branch,
    tool: TOOL,
    environment: `${platform()}-${arch()}-node${process.versions.node}`,
    inputHash: injectionInputHash(
      readFileSync(join(templateDir, "template.json"), "utf8"),
      ownProofs.map((p) => readFileSync(join(templateDir, p.proofTest))),
      baseCommit,
    ),
  };
  // Checked before the answer key is written: an event refused after it would leave a case id with no
  // injection event, which no rerun could repair (Qodo on PR 269).
  const eventIssues = eventProblems(event);
  if (eventIssues.length) refuse(`the injection event would be refused: ${eventIssues.join("; ")}`);
  appendAnswerKeyEntry(ledgerPath, entry);
  appendEvent(auditPath, event);
  deps.log(
    template.kind === "bug"
      ? `validated: proof(s) pass on base, fail on variant; public tests ${publicTests}`
      : `validated: the control passes all ${proofs.length} corpus proofs and the public tests`,
  );
  deps.log(
    `${caseId} -> branch ${branch} @ ${injectionCommit.slice(0, 7)}, ${template.file}:${injectedLines.join("-")}`,
  );
  deps.log(`ledger: ${ledgerPath}`);
  return 0;
}

const USAGE =
  "usage: npm run inject -- --template <id> --target <path> --case <FF-NNNN>\n" +
  "   or: npm run inject -- --template <id> --target <path> --validate-only";

/** The command line as `inject.ts` gets it: a usage problem is a refusal (1), as it always was. */
export function main(argv: string[], deps: () => InjectDeps = liveInjectDeps): number {
  let values: { template?: string; target?: string; case?: string; "validate-only"?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        template: { type: "string" },
        target: { type: "string" },
        case: { type: "string" },
        "validate-only": { type: "boolean" },
      },
    }));
  } catch (e) {
    console.error(`[inject] refused: ${errorText(e)}\n${USAGE}`);
    return 1;
  }
  const validateOnly = values["validate-only"] ?? false;
  if (!values.template || !values.target || (!validateOnly && !values.case)) {
    console.error(`[inject] ${USAGE}`);
    return 1;
  }
  return run({ template: values.template, target: values.target, caseId: values.case, validateOnly }, deps());
}

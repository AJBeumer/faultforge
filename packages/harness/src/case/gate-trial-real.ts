/**
 * The real outside world of a gate trial (`gate-trial-run.ts`): the scratch copy of the reviewed repository,
 * Qodo's local review through its CLI, the builder agent, the proof runs and the saved record.
 *
 * The scratch copy fetches from the public GitHub address, which the reviewer needs to find the base commit,
 * and its push address is disabled, so nothing can be pushed from it. The builder runs in the scratch copy
 * with no variable of this project in its environment, no MCP server, no settings of this project, tools
 * limited to files and the repository's own checks, and read access to the lab's checkouts denied.
 *
 * Each round asks for a full review (`--full`), so a round's findings are the whole list for the code as it
 * is then, and nothing depends on what the reviewer remembers of the round before.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProof } from "../inject/inject-run.ts";
import {
  applyMutation,
  applyTestChange,
  loadTemplate,
  type Proof,
  proofCorpus,
  proofsOf,
} from "../inject/inject-template.ts";
import { readAuditLog, readLedger } from "../ledger/ledger.ts";
import { gateOf, loadFactory, type QualityGate, repoConfig } from "../shared/factory-config.ts";
import { evidenceDir, privateDir, ROOT } from "../shared/paths.ts";
import { TOOL } from "../shared/provenance.ts";
import type { Outcome } from "../shared/run-outcome.ts";
import { templateDir } from "../shared/templates.ts";
import { publicCaseIds } from "./gate-replay.ts";
import { evidencePathProblem, parseDecisions, type TrialFinding, type TrialReview } from "./gate-trial.ts";
import { gateNamed, type TrialArgs, type TrialCase, type TrialIo, trialCase } from "./gate-trial-run.ts";

/** Pure: true for an argument made only of letters, digits and `. _ / @ : = -`, which no shell reads as syntax. */
export function isPlainArgument(arg: string): boolean {
  return /^[\w./@:=-]+$/.test(arg);
}

/** Runs a command and returns its status and output; never throws for a non-zero exit. */
function sh(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 10 * 60_000,
  extra: { input?: string; env?: NodeJS.ProcessEnv } = {},
) {
  // npm and npx are command files on Windows, which only a shell can start. A shell reads its arguments as
  // text, so there every argument must be plain: nothing a shell could take as a second command.
  const shell = process.platform === "win32" && !cmd.toLowerCase().endsWith(".exe") && cmd !== "git";
  const unsafe = shell ? args.find((arg) => !isPlainArgument(arg)) : undefined;
  if (unsafe !== undefined) throw new Error(`refusing to pass an argument with shell characters to ${cmd}`);
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    input: extra.input,
    env: extra.env,
    shell,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function must(what: string, result: ReturnType<typeof sh>): string {
  if (result.status !== 0) {
    throw new Error(`${what} failed (exit ${result.status}): ${(result.stderr || result.stdout).trim().slice(-400)}`);
  }
  return result.stdout;
}

/** The push address every scratch copy gets: no host answers it, so nothing can be pushed from the copy. */
export const NO_PUSH = "no-push://disabled";

/**
 * A scratch copy of `checkout` at `commit`: fetch address `fetchUrl`, push address disabled. With `install`,
 * its dependencies are installed too.
 */
export function makeScratch(
  parent: string,
  checkout: string,
  fetchUrl: string,
  commit: string,
  install = true,
): string {
  const app = join(parent, "app");
  must("git clone", sh("git", ["clone", "--quiet", "--no-hardlinks", checkout, app], parent));
  must("git remote set-url", sh("git", ["remote", "set-url", "origin", fetchUrl], app));
  must("git remote set-url --push", sh("git", ["remote", "set-url", "--push", "origin", NO_PUSH], app));
  must("git checkout", sh("git", ["checkout", "--quiet", "--detach", commit], app));
  if (install) must("npm ci", sh("npm", ["ci", "--no-audit", "--no-fund"], app));
  return app;
}

/** The Qodo CLI: `FAULTFORGE_QODO`, else the toolbox's install under the home folder. */
function qodoBinary(): string {
  if (process.env.FAULTFORGE_QODO) return process.env.FAULTFORGE_QODO;
  return join(homedir(), ".qodo", "bin", process.platform === "win32" ? "qodo.exe" : "qodo");
}

/** The Claude Code binary, found the way the factory finds it. */
function claudeBinary(): string {
  if (process.env.FAULTFORGE_CLAUDE) return process.env.FAULTFORGE_CLAUDE;
  const exe = join(process.env.APPDATA ?? "", "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe");
  return process.platform === "win32" && existsSync(exe) ? exe : "claude";
}

/** The ids in one `finding_state` list, whether it holds ids or whole findings. */
function idsIn(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => (typeof entry === "string" ? entry : (entry as { id?: unknown } | null)?.id))
    .filter((id): id is string => typeof id === "string");
}

/**
 * Pure: the CLI's `qodo review --json` answer as the loop reads it. Complete only when the answer is a
 * result (not an error), its findings can all be read, and it says its coverage of the change was complete.
 * A finding the answer lists as resolved or dismissed is not open.
 */
export function readLocalReview(stdout: string, evidence: string): TrialReview {
  const none: TrialReview = { complete: false, open: [], evidence };
  let payload: Record<string, unknown>;
  try {
    // The CLI can end its output with a `trace <hex>` line.
    payload = JSON.parse(stdout.replace(/\r?\n\s*trace [0-9a-f]+\s*$/i, ""));
  } catch {
    return none;
  }
  if (!payload || typeof payload !== "object" || payload.error || !Array.isArray(payload.findings)) return none;
  const state = (payload.finding_state ?? {}) as Record<string, unknown>;
  const closed = new Set([...idsIn(state.resolved), ...idsIn(state.dismissed)]);
  const open: TrialFinding[] = [];
  for (const entry of payload.findings as unknown[]) {
    if (!entry || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string") return none;
    const f = entry as Record<string, unknown>;
    if (closed.has(f.id as string)) continue;
    const at = (f.location ?? f.diff_reference ?? {}) as Record<string, unknown>;
    const lines =
      Number.isInteger(at.start_line) && Number.isInteger(at.end_line)
        ? ([at.start_line, at.end_line] as [number, number])
        : null;
    open.push({
      id: f.id as string,
      severity: typeof f.action_level === "string" ? f.action_level : null,
      title: typeof f.title === "string" ? f.title : null,
      category: typeof f.category === "string" ? f.category : null,
      file: typeof at.file_path === "string" ? at.file_path : null,
      lines,
      description: typeof f.description === "string" ? f.description : null,
    });
  }
  const meta = (payload.meta ?? {}) as { coverage?: { complete?: unknown }; skipped_files?: unknown };
  const skipped = Array.isArray(meta.skipped_files) ? meta.skipped_files.length : 0;
  return { complete: meta.coverage?.complete === true && skipped === 0, open, evidence };
}

/** How many times one round's review is asked for when the reviewer answers with an error. */
export const REVIEW_ATTEMPTS = 3;

/**
 * Pure: true when the CLI's output is an error and not a review, or isn't JSON at all. Only then is the
 * review asked for again: a review that came back incomplete is a result, and stays one.
 */
export function isErrorAnswer(stdout: string): boolean {
  try {
    const payload = JSON.parse(stdout.replace(/\r?\n\s*trace [0-9a-f]+\s*$/i, ""));
    return !payload || typeof payload !== "object" || Boolean((payload as { error?: unknown }).error);
  } catch {
    return true;
  }
}

/** The tools the builder may use: files in its folder, and the repository's own checks. No network, no git writes. */
export const BUILDER_TOOLS: readonly string[] = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash(npm test:*)",
  "Bash(npm run check:*)",
  "Bash(npm run format:*)",
  "Bash(npm run test:*)",
  "Bash(npx vitest:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
];

/** The builder's command line: only `BUILDER_TOOLS`, no MCP server, no project or user settings, a capped budget. */
export function builderArgs(settingsFile: string, mcpConfigFile: string, budgetUsd: number): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    BUILDER_TOOLS.join(","),
    "--max-budget-usd",
    String(budgetUsd),
    "--settings",
    settingsFile,
    "--mcp-config",
    mcpConfigFile,
    "--strict-mcp-config",
  ];
}

/** Deny rules for the builder: the folder that holds the lab's checkouts, in both spellings of its drive. */
export function builderDeny(labRoot: string): string[] {
  // By the text of the path, not this machine's own rules, so it reads the same on every system.
  const root = labRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const parent = root.slice(0, root.lastIndexOf("/"));
  const drive = /^([a-zA-Z]):\/(.*)$/.exec(parent);
  const spellings = drive
    ? [`//${(drive[1] as string).toLowerCase()}/${drive[2]}`, `//${(drive[1] as string).toUpperCase()}/${drive[2]}`]
    : [`/${parent}`];
  return spellings.flatMap((p) => ["Read", "Edit", "Write", "Grep", "Glob"].map((tool) => `${tool}(${p}/**)`));
}

/** The environment the builder runs in: no variable of this project, of Qodo or of GitHub. */
export function builderEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(FAULTFORGE_|QODO_|GH_|GITHUB_)/i.test(name)));
}

export interface RealTrial {
  facts: TrialCase;
  gate: QualityGate;
  io: TrialIo;
  recordDir: string;
  cleanup: () => void;
}

/** The real trial for the command's arguments, or why it can't start and the exit code for that. */
export function realTrial(args: TrialArgs): RealTrial | { refusal: string; code: 1 | 2 } {
  const factory = loadFactory();
  const priv = privateDir();
  const reviewed = Object.keys(factory.repos).find((key) => factory.repos[key]?.guard === "reviewed");
  if (!reviewed) return { refusal: "factory.json names no reviewed repository", code: 2 };
  const target = repoConfig(factory, reviewed);
  const decisions = join(ROOT, "docs", "decisions");
  const facts = trialCase(
    args.caseId,
    readLedger(join(priv, "ground-truth.jsonl")) as Record<string, unknown>[],
    readAuditLog(join(priv, "audit-events.jsonl")) as Record<string, unknown>[],
    publicCaseIds(
      readdirSync(decisions)
        .filter((f) => f.endsWith(".md"))
        .map((f) => readFileSync(join(decisions, f), "utf8")),
    ),
  );
  if ("refusal" in facts) return { refusal: facts.refusal, code: 1 };
  const where = templateDir(facts.templateId);
  if (!where) return { refusal: "the case's template is not in private storage or templates/seed", code: 2 };
  const template = loadTemplate(where);
  const gate = gateNamed(args.gate, gateOf(factory));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const recordDir = join(evidenceDir(factory), "gate-trials", `${stamp}-${facts.caseId}-${args.gate}`);
  mkdirSync(recordDir, { recursive: true });
  const parent = mkdtempSync(join(tmpdir(), "gate-trial-"));
  const app = join(parent, "app");
  const settingsFile = join(parent, "builder-settings.json");
  const mcpConfigFile = join(parent, "builder-mcp.json");
  const log = (line: string) => console.log(line);

  const own = proofsOf(template);
  const ownKeys = new Set(own.map((p) => `${p.invariantId}/${p.proofTest}`));
  const others = proofCorpus([join(priv, "templates"), join(ROOT, "templates", "seed")]).filter(
    (p) => !(p.dir === where && ownKeys.has(`${p.invariantId}/${p.proofTest}`)),
  );
  const proofs: { proof: Proof; own: boolean }[] = [
    ...own.map((proof) => ({ proof, own: true })),
    ...others.map((proof) => ({ proof, own: false })),
  ];
  const diff = () => sh("git", ["diff"], app).stdout;

  const io: TrialIo = {
    prepare: async () => {
      log(`Scratch copy at ${facts.targetCommit.slice(0, 7)} in ${parent}`);
      makeScratch(parent, resolve(ROOT, target.path), `https://github.com/${target.github}.git`, facts.targetCommit);
      applyMutation(app, template);
      if (template.testChange) applyTestChange(app, template.testChange);
      writeFileSync(join(recordDir, "change.diff"), diff());
      writeFileSync(settingsFile, JSON.stringify({ permissions: { deny: builderDeny(ROOT) } }, null, 2));
      writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: {} }));
    },
    proofs: () => proofs.map(({ proof, own: isOwn }) => ({ invariantId: proof.invariantId, own: isOwn })),
    runProofs: async (stage) => {
      const dir = join(recordDir, `proofs-${stage}`);
      mkdirSync(dir, { recursive: true });
      const places = { targetDir: app, artefactDir: dir, templateDir: where };
      return proofs.map(({ proof }, i): Outcome => runProof(places, "variant", proof, i));
    },
    review: async (round) => {
      // The reviewer's service sometimes ends a review with an error and no result. That says nothing about
      // the gate, so the same review is asked for again, at most three times; every answer is kept.
      let review: TrialReview = { complete: false, open: [], evidence: "" };
      for (let attempt = 1; attempt <= REVIEW_ATTEMPTS; attempt++) {
        const result = sh(
          qodoBinary(),
          [
            "review",
            "--repo",
            target.github,
            "--base",
            facts.targetCommit,
            "--ticket",
            facts.ticket.url,
            "--full",
            "--json",
          ],
          app,
          20 * 60_000,
        );
        const name = attempt === 1 ? `review-${round}` : `review-${round}.attempt-${attempt}`;
        const evidence = join(recordDir, `${name}.json`);
        writeFileSync(evidence, result.stdout);
        writeFileSync(join(recordDir, `${name}.stderr.txt`), result.stderr);
        review = readLocalReview(result.stdout, evidence);
        if (!isErrorAnswer(result.stdout)) break;
        log(`  the reviewer answered with an error (attempt ${attempt} of ${REVIEW_ATTEMPTS})`);
      }
      return review;
    },
    build: async (round, prompt, mustFix) => {
      writeFileSync(join(recordDir, `builder-${round}.prompt.txt`), prompt);
      const result = sh(claudeBinary(), builderArgs(settingsFile, mcpConfigFile, 4), app, 25 * 60_000, {
        input: prompt,
        env: builderEnv(process.env),
      });
      writeFileSync(join(recordDir, `builder-${round}.json`), result.stdout);
      writeFileSync(join(recordDir, `builder-${round}.stderr.txt`), result.stderr);
      writeFileSync(join(recordDir, `change-after-round-${round}.diff`), diff());
      let reply = result.stdout;
      try {
        reply = String((JSON.parse(result.stdout) as { result?: unknown }).result ?? "");
      } catch {
        // Not the JSON envelope: the raw output is read for the decisions line instead.
      }
      return parseDecisions(
        reply,
        mustFix.map((f) => f.id),
      );
    },
    evidencePasses: async (testFile) => {
      // The path is the builder's text: checked, and written with forward slashes, before it reaches a command.
      const path = testFile.replace(/\\/g, "/");
      if (evidencePathProblem(path) || !existsSync(join(app, path))) return false;
      return sh("npx", ["vitest", "run", path], app, 5 * 60_000).status === 0;
    },
    publicTests: async () => {
      const result = sh("npm", ["test"], app, 10 * 60_000);
      writeFileSync(join(recordDir, "public-tests-after.log"), `${result.stdout}\n${result.stderr}`);
      writeFileSync(join(recordDir, "change-final.diff"), diff());
      return result.status === 0 ? "pass" : "fail";
    },
    save: (record) =>
      writeFileSync(
        join(recordDir, "trial.json"),
        `${JSON.stringify({ tool: TOOL, recordedAt: new Date().toISOString(), ...record }, null, 2)}\n`,
      ),
    log,
  };
  return {
    facts,
    gate,
    io,
    recordDir,
    cleanup: () => {
      if (args.keep) log(`Scratch copy kept in ${parent}`);
      else rmSync(parent, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

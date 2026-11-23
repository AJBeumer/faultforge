/**
 * `npm run skill:exam`: runs the `prove-finding` skill blind on a key of matched pairs, one fresh headless
 * Claude Code session per trial, and scores the verifier's certificates (`skill-exam.ts`).
 *
 * Usage: npm run skill:exam -- --key <key.json> --out <dir> [--only t1,t2] [--budget <usd>] [--rescore]
 *
 * The key (kept in private storage; its sha256 is committed before any session runs) holds `pairs`, each with
 * the finding's `title` and `description` and its location on the `reviewed` and the `fixed` commit, and
 * `trials` (`trial`, `pair`, `side`) in the order they run. A session sees only its trial's commit, file,
 * lines and finding text.
 *
 * Per trial: an export of the commit (no `.git`, no private storage, its own `npm ci`) with this checkout's
 * skill copied in and the export's own hook settings removed; one session started in it with only file tools,
 * Vitest and the Skill tool, the lab's folders and private storage denied to its file tools, no MCP server and
 * no project, Qodo or GitHub variable; its transcript saved raw. Then the bundle is copied out and verified
 * against a fresh export, and the reviewed side's test also runs on the fixed commit. `--rescore` skips the
 * sessions and scores what is saved.
 *
 * Exit codes: 0 the exam ran and was scored (whatever the decision); 2 could not run (bad arguments, a missing
 * key, an export or a verification that failed to run).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { builderDeny, plainEnv } from "../case/gate-trial-builder.ts";
import { claudeBinary } from "../factory/factory-agent.ts";
import { privateDir } from "../shared/paths.ts";
import { sha256 } from "../shared/provenance.ts";
import { exportCommit, SetupError, testOnCommit, verifyBundle } from "./proof-run.ts";
import { examDecision, loadedFirst, type PairResult, readTranscript } from "./skill-exam.ts";

const SKILL = "prove-finding";
const SESSION_TIMEOUT_MS = 30 * 60_000;
// The skill's helper runs the test: Claude Code refuses file writes under `.claude/`, where the hooks live.
const TOOLS = [
  "Skill",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "TodoWrite",
  `Bash(node .claude/skills/${SKILL}/try-proof.mjs:*)`,
  "Bash(npx vitest:*)",
  "Bash(npx tsc:*)",
];

interface Location {
  commit: string;
  file: string;
  start: number;
  end: number;
}
interface Key {
  pairs: { pair: string; title: string; description: string; reviewed: Location; fixed: Location }[];
  trials: { trial: string; pair: string; side: "reviewed" | "fixed" }[];
}

/** What the session is told: the finding and where it points, nothing about the pair or the side. */
export function trialPrompt(loc: Location, title: string, description: string): string {
  return [
    `Use the ${SKILL} skill on this review finding.`,
    `Cited file: ${loc.file}`,
    `Cited lines: ${loc.start}-${loc.end}`,
    "Bundle folder: proof-bundle/",
    `Finding title: ${title}`,
    "Finding description:",
    description,
  ].join("\n");
}

function runSession(dir: string, prompt: string, tdir: string, budget: number, repo: string): void {
  const settings = join(tdir, "session-settings.json");
  writeFileSync(settings, JSON.stringify({ permissions: { deny: builderDeny(repo, privateDir()) } }, null, 2));
  const mcp = join(tdir, "session-mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk"];
  // Commas, not spaces: a rule such as `Bash(npx vitest:*)` holds a space (exam run 1 lost Bash that way).
  args.push("--allowedTools", TOOLS.join(","), "--max-budget-usd", String(budget));
  args.push("--settings", settings, "--mcp-config", mcp, "--strict-mcp-config", "--disallowedTools", "ScheduleWakeup");
  const started = new Date().toISOString();
  const result = spawnSync(claudeBinary(), args, {
    cwd: dir,
    env: plainEnv(process.env),
    encoding: "utf8",
    timeout: SESSION_TIMEOUT_MS,
    maxBuffer: 512 * 1024 * 1024,
  });
  // Raw first: the transcript is saved before anything reads it.
  writeFileSync(join(tdir, "transcript.jsonl"), result.stdout ?? "");
  const ended = result.error ? ` (${result.error.message})` : "";
  writeFileSync(join(tdir, "session.log"), `started ${started}\nexit ${result.status}${ended}\n${result.stderr ?? ""}`);
}

/** Runs (unless `rescore`) and verifies one trial; returns its row, also appended to `results.jsonl`. */
function runTrial(repo: string, key: Key, trial: Key["trials"][number], out: string, budget: number, rescore: boolean) {
  const pair = key.pairs.find((p) => p.pair === trial.pair);
  if (!pair) throw new SetupError(`trial ${trial.trial} names pair ${trial.pair}, which the key doesn't have`);
  const loc = pair[trial.side];
  const tdir = join(out, trial.trial);
  const bundle = join(tdir, "bundle");
  if (!rescore) {
    rmSync(tdir, { recursive: true, force: true });
    mkdirSync(tdir, { recursive: true });
    const dir = exportCommit(repo, loc.commit);
    try {
      for (const f of ["settings.json", "settings.local.json"]) rmSync(join(dir, ".claude", f), { force: true });
      cpSync(join(repo, ".claude", "skills", SKILL), join(dir, ".claude", "skills", SKILL), { recursive: true });
      runSession(dir, trialPrompt(loc, pair.title, pair.description), tdir, budget, repo);
      if (existsSync(join(dir, "proof-bundle"))) cpSync(join(dir, "proof-bundle"), bundle, { recursive: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const transcript = existsSync(join(tdir, "transcript.jsonl"))
    ? readFileSync(join(tdir, "transcript.jsonl"), "utf8")
    : "";
  const facts = readTranscript(transcript, SKILL);
  const cited = { file: loc.file, start: loc.start, end: loc.end };
  const cert = existsSync(join(bundle, "proof.json"))
    ? verifyBundle(repo, loc.commit, cited, bundle, join(tdir, "verify"))
    : null;
  let onFixed: string | undefined;
  if (trial.side === "reviewed" && cert?.testPath && existsSync(join(bundle, "proof.test.ts"))) {
    const cross = join(tdir, "on-fixed");
    mkdirSync(cross, { recursive: true });
    const test = readFileSync(join(bundle, "proof.test.ts"), "utf8");
    const ran = testOnCommit(repo, pair.fixed.commit, cert.testPath, test, cross, "on-fixed");
    rmSync(ran.dir, { recursive: true, force: true });
    onFixed = ran.result;
  }
  const row = {
    trial: trial.trial,
    pair: pair.pair,
    side: trial.side,
    commit: loc.commit,
    skillLoadedFirst: loadedFirst(facts, SKILL),
    ...facts,
    claimed: cert?.claimed ?? "no bundle",
    certified: cert?.certified ?? false,
    reasons: cert?.reasons ?? ["the session wrote no bundle"],
    reviewedTestOnFixed: onFixed,
  };
  writeFileSync(join(tdir, "result.json"), `${JSON.stringify(row, null, 2)}\n`);
  return row;
}

type Row = ReturnType<typeof runTrial>;

/** Every trial's saved result in `out`, so a run of some trials is scored with the ones run before. */
function savedRows(key: Key, out: string): Row[] {
  return key.trials
    .map((t) => join(out, t.trial, "result.json"))
    .filter((f) => existsSync(f))
    .map((f) => JSON.parse(readFileSync(f, "utf8")) as Row);
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: string[]): number {
  const keyFile = flag(argv, "key");
  const outFlag = flag(argv, "out");
  if (!keyFile || !outFlag || !existsSync(keyFile)) {
    console.error("usage: skill:exam --key <key.json> --out <dir> [--only t1,t2] [--budget <usd>] [--rescore]");
    return 2;
  }
  const repo = resolve(".");
  const out = resolve(outFlag);
  mkdirSync(out, { recursive: true });
  const keyText = readFileSync(keyFile, "utf8");
  const key = JSON.parse(keyText) as Key;
  const only = flag(argv, "only")?.split(",");
  const budget = Number(flag(argv, "budget") ?? "5");
  const rescore = argv.includes("--rescore");
  console.log(`key sha256 ${sha256(keyText)}`);
  try {
    for (const t of key.trials.filter((t) => !only || only.includes(t.trial))) {
      const row = runTrial(repo, key, t, out, budget, rescore);
      console.log(
        `${row.trial}: skill first ${row.skillLoadedFirst}, claimed ${row.claimed}, certified ${row.certified}`,
      );
    }
    const rows = savedRows(key, out);
    const pairs: PairResult[] = key.pairs
      .map((p) => ({
        p,
        r: rows.find((x) => x.pair === p.pair && x.side === "reviewed"),
        f: rows.find((x) => x.pair === p.pair && x.side === "fixed"),
      }))
      .filter(({ r, f }) => r && f)
      .map(({ p, r, f }) => ({
        pair: p.pair,
        reviewedCertified: Boolean(r?.certified),
        fixedCertified: Boolean(f?.certified),
        reviewedTestOnFixed: r?.reviewedTestOnFixed,
      }));
    const decision = pairs.length === key.pairs.length ? examDecision(pairs) : "incomplete";
    const score = { keySha256: sha256(keyText), pairs, decision, scoredAt: new Date().toISOString() };
    writeFileSync(join(out, "score.json"), `${JSON.stringify(score, null, 2)}\n`);
    console.log(`decision: ${decision}`);
    return 0;
  } catch (e) {
    console.error(`skill:exam could not run: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

/**
 * The exam of the `prove-finding` skill: what a session's transcript shows, and the score. Pure; the runner is
 * `skill-exam-run.ts`.
 *
 * Each pair is one review finding with a known answer: on the commit that was reviewed the finding is real; on
 * the commit that fixed it, it isn't. Both sides run blind, in fresh sessions. Only the verifier's
 * certificates are scored, never what the agent says.
 */

/** The first tool call in a `stream-json` transcript, and what the session listed and spent. */
export interface TranscriptFacts {
  firstTool: string | null;
  firstSkill: string | null;
  skillListed: boolean;
  costUsd: number | null;
  finalLine: string | null;
}

export function readTranscript(text: string, skill: string): TranscriptFacts {
  const facts: TranscriptFacts = {
    firstTool: null,
    firstSkill: null,
    skillListed: false,
    costUsd: null,
    finalLine: null,
  };
  for (const raw of text.split(/\r?\n/)) {
    let line: {
      type?: string;
      subtype?: string;
      skills?: unknown;
      slash_commands?: unknown;
      total_cost_usd?: number;
      result?: string;
      message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] };
    };
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (line.type === "system" && line.subtype === "init") {
      const listed = [line.skills, line.slash_commands].flatMap((l) => (Array.isArray(l) ? l : []));
      facts.skillListed = listed.some((s) => (typeof s === "string" ? s : (s as { name?: string })?.name) === skill);
    }
    if (line.type === "assistant" && facts.firstTool === null) {
      const call = line.message?.content?.find((c) => c.type === "tool_use");
      if (call) {
        facts.firstTool = call.name ?? null;
        const input = call.input ?? {};
        facts.firstSkill = String(input.skill ?? input.command ?? input.name ?? "") || null;
      }
    }
    if (line.type === "result") {
      facts.costUsd = typeof line.total_cost_usd === "number" ? line.total_cost_usd : null;
      const last = (line.result ?? "").trim().split(/\r?\n/).at(-1) ?? "";
      facts.finalLine = last || null;
    }
  }
  return facts;
}

/** True when the first tool call loaded the skill. */
export function loadedFirst(facts: TranscriptFacts, skill: string): boolean {
  return facts.firstTool === "Skill" && facts.firstSkill?.replace(/^\//, "") === skill;
}

/** One pair's outcome: certificates on each side, and how the reviewed side's test ended on the fixed commit. */
export interface PairResult {
  pair: string;
  reviewedCertified: boolean;
  fixedCertified: boolean;
  /** "green" means the proof test agrees with the real fix; unset when there was no test to run. */
  reviewedTestOnFixed?: string;
}

/** `skill:exam`'s options. `repo` holds the key's commits: this checkout unless `--repo` names another. */
export interface ExamOptions {
  key: string;
  out: string;
  repo: string;
  only?: string[];
  budget: number;
  rescore: boolean;
}

/** The options from `argv`, read with `flag`; null when `--key` or `--out` is missing or `--budget` isn't a number. */
export function examOptions(
  argv: string[],
  flag: (argv: string[], name: string) => string | undefined,
): ExamOptions | null {
  const key = flag(argv, "key");
  const out = flag(argv, "out");
  const budget = Number(flag(argv, "budget") ?? "5");
  if (!key || !out || !Number.isFinite(budget) || budget <= 0) return null;
  const only = flag(argv, "only")?.split(",");
  return {
    key,
    out,
    repo: flag(argv, "repo") ?? ".",
    budget,
    rescore: argv.includes("--rescore"),
    ...(only ? { only } : {}),
  };
}

/** What the scoring reads from one trial's saved result. */
export interface TrialRow {
  pair: string;
  side: "reviewed" | "fixed";
  certified: boolean;
  skillLoadedFirst: boolean;
  reviewedTestOnFixed?: string;
}

/**
 * Each pair with both sides run. A reviewed-side certificate counts only when the session loaded the skill as its
 * first tool call: the exam tests the skill, not a session that wrote a bundle some other way. A fixed-side
 * certificate counts against the skill however the session got there.
 */
export function pairResults(pairs: string[], rows: TrialRow[]): PairResult[] {
  return pairs.flatMap((pair) => {
    const r = rows.find((x) => x.pair === pair && x.side === "reviewed");
    const f = rows.find((x) => x.pair === pair && x.side === "fixed");
    if (!r || !f) return [];
    const result: PairResult = {
      pair,
      reviewedCertified: r.certified && r.skillLoadedFirst,
      fixedCertified: f.certified,
    };
    if (r.reviewedTestOnFixed !== undefined) result.reviewedTestOnFixed = r.reviewedTestOnFixed;
    return [result];
  });
}

export type ExamDecision = "works" | "fails" | "inconclusive";

/**
 * The rule fixed before the exam ran: works when at least two of three pairs got a certificate on the reviewed
 * commit and none on the fixed commit; fails on any certificate on a fixed commit (a false proof); inconclusive
 * otherwise.
 */
export function examDecision(pairs: PairResult[]): ExamDecision {
  if (pairs.some((p) => p.fixedCertified)) return "fails";
  const proven = pairs.filter((p) => p.reviewedCertified).length;
  return pairs.length > 0 && proven * 3 >= pairs.length * 2 ? "works" : "inconclusive";
}

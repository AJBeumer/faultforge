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

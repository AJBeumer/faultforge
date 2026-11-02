/**
 * Words that must never appear in anything the reviewer can see in the target repository:
 * branch names, commit messages, PR titles and bodies, comments, and file contents.
 * Shared by the inject command and the Claude Code guard hook.
 */
const TELLTALES: [RegExp, string][] = [
  [/\bfault[\s_-]*forge\b(?!-target)/i, "names the lab"],
  [/\bsabot(age|aged|eur|eurs)\b/i, "says sabotage"],
  [/\bplanted\b/i, "says planted"],
  [/\b(injected|inserted)\s+(bug|defect|fault)s?\b|\b(bug|defect|fault)\s+injection\b/i, "says a bug was injected"],
  [/\bmutation(s|\s+test(ing)?)?\b/i, "says mutation"],
  [/\banswer[\s-]*key\b/i, "mentions the answer key"],
  [/\bledger\b/i, "mentions the ledger"],
  [/\bground[\s-]*truth\b/i, "mentions ground truth"],
  [/\b(proof|hidden)\s+tests?\b/i, "mentions the hidden proof test"],
  [/\bdevil'?s\s+advocate\b/i, "names the challenger"],
  [/\bFF-\d{3,}\b/, "contains a case id"],
];

/** Returns the reasons a text would give the lab away, or an empty list if it reads as ordinary. */
export function telltales(text: string): string[] {
  return TELLTALES.filter(([pattern]) => pattern.test(text)).map(([, reason]) => reason);
}

/**
 * Words that must never appear in anything the reviewer can see in the target repository:
 * branch names, commit messages, PR titles and bodies, comments, and file contents.
 * Shared by the inject command and the Claude Code guard hook.
 */
const TELLTALES: [RegExp, string][] = [
  [/\bfault[\s_-]*forge\b(?!-target)/i, "names the lab"],
  // Two-word phrases match with a space, a hyphen or an underscore between the words, as branch names
  // write them, and in either case (#190).
  [/\bsabot(ag\w*|eurs?)\b/i, "says sabotage"],
  [/\bplanted\b|\bplant(ing)?[\s_-]+(an?[\s_-]+|the[\s_-]+)?(bug|defect|fault)s?\b/i, "says planted"],
  [
    /\b(injected|inserted)[\s_-]+(bug|defect|fault)s?\b|\b(bug|defect|fault)[\s_-]+injection\b/i,
    "says a bug was injected",
  ],
  [/\bmutation(s|[\s_-]+test(ing)?)?\b|\bmutants?\b/i, "says mutation"],
  [/\banswer[\s_-]*key\b/i, "mentions the answer key"],
  [/\bledger\b/i, "mentions the ledger"],
  [/\bground[\s_-]*truth\b/i, "mentions ground truth"],
  [/\b(proof|hidden)[\s_-]+tests?\b/i, "mentions the hidden proof test"],
  [/\bdevil'?s[\s_-]+advocate\b/i, "names the challenger"],
  [/\bff[\s_-]?\d{3,}\b/i, "contains a case id"],
];

/** Cyrillic and Greek letters that look like Latin ones, mapped to the Latin letter a reader sees. */
const LOOKALIKES: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ї: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ԛ: "q",
  ԝ: "w",
  ɡ: "g",
  ı: "i",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  У: "Y",
  Х: "X",
  І: "I",
  Ј: "J",
  Ѕ: "S",
  α: "a",
  ο: "o",
  ρ: "p",
  ν: "v",
  τ: "t",
  ι: "i",
  κ: "k",
  υ: "u",
  ε: "e",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
  ɑ: "a",
};

/**
 * The text as a reader sees it: compatibility forms folded (NFKC: full-width letters, ligatures), invisible
 * characters removed (zero-width spaces and joiners, the soft hyphen, the word joiner, the byte-order mark),
 * every kind of dash read as `-`, and Cyrillic or Greek look-alike letters read as the Latin letter.
 */
export function normalizeLookalikes(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[​-‍⁠﻿­᠎]/g, "")
    .replace(/[‐-―−﹘﹣－]/g, "-")
    .replace(/[Ͱ-ϿЀ-ԯɡıɑ]/g, (ch) => LOOKALIKES[ch] ?? ch);
}

/** Digits and signs read as letters (leetspeak), except `1`, which reads as either `i` or `l`. */
const LEET: Record<string, string> = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

/**
 * The text's leetspeak readings (#285): `pl4nt3d` and `p1@nted` read `planted`. Two readings, because `1`
 * stands for `i` as often as for `l`. Used beside the text as written, never instead of it: a case id such
 * as `FF-0012` is digits, and only the text as written still shows it.
 */
export function leetReadings(text: string): string[] {
  const base = text.replace(/[03457@$]/g, (ch) => LEET[ch] ?? ch);
  return [...new Set([base.replace(/1/g, "i"), base.replace(/1/g, "l")])];
}

/**
 * Returns the reasons a text would give the lab away, or an empty list if it reads as ordinary. The text is
 * read as a reader sees it: look-alike letters and invisible characters can't hide a word (#242), and
 * neither can digits written for letters (#285).
 */
export function telltales(text: string): string[] {
  const seen = normalizeLookalikes(text);
  const readings = [seen, ...leetReadings(seen)];
  return TELLTALES.filter(([pattern]) => readings.some((reading) => pattern.test(reading))).map(([, reason]) => reason);
}

/**
 * The reasons a bug template would give its case away, as `field: reason`, over every field that reaches
 * the reviewed repository: the branch name and commit message, the text it looks for and the text it
 * writes (`find`, `replace`), and, when the template declares one, its ticket's title, `what` and
 * criteria — the target ticket the case PR will claim to make. The proof test stays in private storage,
 * so its name is not checked. The template's own `id` and `invariantId` are refused in every one of those
 * fields too. An empty list means the template reads as an ordinary change.
 */
export function templateTelltales(template: {
  id?: string;
  invariantId?: string;
  find: string;
  replace: string;
  publish: { branch: string; commitMessage: string };
  ticket?: { title: string; what: string; criteria: string[] };
}): string[] {
  const fields: [string, string][] = [
    ["branch", template.publish.branch],
    ["commitMessage", template.publish.commitMessage],
    ["find", template.find],
    ["replace", template.replace],
    ...(template.ticket
      ? ([
          ["ticket.title", template.ticket.title],
          ["ticket.what", template.ticket.what],
          ...template.ticket.criteria.map((c, i): [string, string] => [`ticket.criteria[${i}]`, c]),
        ] as [string, string][])
      : []),
  ];
  // The template's own id and invariant id are names only the lab uses: either one in a visible field
  // gives the case away whatever the word list says (#190).
  const ownNames = [template.id, template.invariantId].filter((name): name is string => Boolean(name));
  const named = (text: string) =>
    ownNames.filter((name) => text.toLowerCase().includes(name.toLowerCase())).map((name) => `names ${name}`);
  return fields.flatMap(([field, text]) => [...telltales(text), ...named(text)].map((reason) => `${field}: ${reason}`));
}

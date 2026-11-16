/**
 * Words that must never appear in anything the reviewer can see in the target repository:
 * branch names, commit messages, PR titles and bodies, comments, and file contents.
 * Shared by the inject command and the Claude Code guard hook.
 */
const LAB_REASON = "names the lab";

const TELLTALES: [RegExp, string][] = [
  // The lab's name wherever a word could start: after a separator, a digit or a camel-case join, with anything
  // after it (`faultforge_private`, `FaultForgeLab`, `faultforge2`). Read on the text with its camel-case
  // joins split too (`joinsSplit`). Only the target's own name, `faultforge-target`, passes.
  [/(?:^|[^a-z])fault[\s_-]*forge(?!-target)/i, LAB_REASON],
  // Two-word phrases match with a space, a hyphen or an underscore between the words, as branch names
  // write them, and in either case.
  [/\bsabot(ag\w*|eurs?)\b/i, "says sabotage"],
  [/\bplanted\b|\bplant(ing)?[\s_-]+(an?[\s_-]+|the[\s_-]+)?(bug|defect|fault)s?\b/i, "says planted"],
  [
    /\b(injected|inserted)[\s_-]+(bug|defect|fault)s?\b|\b(bug|defect|fault)[\s_-]+injection\b/i,
    "says a bug was injected",
  ],
  // Synonyms for a bug put there on purpose. Each needs a bug word or "on purpose" next to it, so dependency
  // injection, a seeded database or a deliberate 404 stay ordinary text.
  [
    /\bseeded[\s_-]+(bug|defect|fault|flaw|vulnerabilit(y|ies))s?\b|\b(bug|defect|fault)[\s_-]+seeding\b|\b(deliberate|intentional|purposeful|artificial|synthetic)[\s_-]+(bug|defect|fault|flaw|regression)s?\b/i,
    "says a bug was put there on purpose",
  ],
  [
    /\b(injected|inserted|introduced|seeded|planted|bugs?|defects?|faults?|flaws?)\b[\w\s,-]{0,30}?\b(on[\s_-]+purpose|deliberately|intentionally|purposely|purposefully)\b|\b(deliberately|intentionally|purposely|purposefully)[\s_-]+(injected|inserted|introduced|seeded|broken|buggy)\b/i,
    "says a bug was put there on purpose",
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
 * Named HTML entities a separator, a mark or an invisible character can hide behind. Any other named entity is
 * left as written: GitHub shows one it doesn't know as its own text.
 */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  hairsp: " ",
  tab: " ",
  newline: " ",
  hyphen: "-",
  dash: "-",
  ndash: "-",
  mdash: "-",
  minus: "-",
  lowbar: "_",
  period: ".",
  colon: ":",
  sol: "/",
  shy: "",
  zerowidthspace: "",
  zwj: "",
  zwnj: "",
  nobreak: "",
  invisibletimes: "",
  invisiblecomma: "",
  invisibleseparator: "",
  applyfunction: "",
};

/** A tag that breaks a line or starts a block, read as a new line: `x-secret<br>v1` shows two lines. */
const BLOCK_TAG = /<\/?(?:br|p|div|hr|li|ul|ol|h[1-6]|blockquote|pre|table|tr|td|th|details|summary)\b[^<>]*>/gi;

/** Inline HTML tags GitHub renders as nothing but style, so `plan<b></b>ted` reads `planted`. */
const INLINE_TAG =
  /<\/?(?:a|b|i|u|s|q|em|strong|ins|del|sub|sup|span|code|kbd|mark|small|big|tt|abbr|cite|dfn|var|samp|wbr|strike)\b[^<>]*>/gi;

/**
 * The text as markdown renders it: HTML comments and inline tags removed, block tags read as new lines, HTML
 * entities decoded (`&#102;`, `&#x66;`, `&amp;`), and emphasis markers removed (`**`, `__`, `~~`, backticks),
 * so `fault<!-- -->forge`, `pl&#97;nted` and `plan**ted**` read as the words they show. A dot between two
 * letters or digits reads as a space, so `answer.key` reads as two words, as a separator would.
 */
export function renderedText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(BLOCK_TAG, "\n")
    .replace(INLINE_TAG, "")
    .replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,31}));?/gi, (whole, dec, hex, name) => {
      if (name) return /;$/.test(whole) ? (ENTITIES[name.toLowerCase()] ?? whole) : whole;
      const code = dec ? Number(dec) : Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/[*~`]+|_{2,}/g, "")
    .replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, " ");
}

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

/**
 * The ways a reader may see the text, each normalised (`normalizeLookalikes`): as written, and as markdown
 * renders it (`renderedText`). Both, because removing a mark can join a word to the one before it (a code span
 * right after a letter), and the word's start is then seen only as written. One view when rendering changes
 * nothing. The one step `telltales` and the guard's private-id test both read text through.
 */
export function readerViews(text: string): string[] {
  const rendered = renderedText(text);
  return rendered === text
    ? [normalizeLookalikes(text)]
    : [...new Set([normalizeLookalikes(text), normalizeLookalikes(rendered)])];
}

/** Digits and signs read as letters (leetspeak), except `1`, which reads as either `i` or `l`. */
const LEET: Record<string, string> = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

/**
 * The text's leetspeak readings: `pl4nt3d` and `p1@nted` read `planted`. Two readings, because `1`
 * stands for `i` as often as for `l`. Used beside the text as written, never instead of it: a case id such
 * as `FF-0012` is digits, and only the text as written still shows it.
 */
export function leetReadings(text: string): string[] {
  const base = text.replace(/[03457@$]/g, (ch) => LEET[ch] ?? ch);
  // A third, mixed reading for words that use `1` both ways (`p1ant1ng`): before a vowel it reads `l`, else `i`.
  const mixed = base.replace(/1(?=[aeiouy])/gi, "l").replace(/1/g, "i");
  return [...new Set([base.replace(/1/g, "i"), base.replace(/1/g, "l"), mixed])];
}

/**
 * The text with each camel-case join read as two words (`FaultForgeLab` reads `Fault Forge Lab`),
 * so a pattern that looks for a word's start finds one inside a joined name.
 */
export function joinsSplit(text: string): string {
  return text.replace(/([a-z])(?=[A-Z])/g, "$1 ").replace(/([A-Z])(?=[A-Z][a-z])/g, "$1 ");
}

/**
 * Returns the reasons a text would give the lab away, or an empty list if it reads as ordinary. The text is
 * read as a reader sees it: look-alike letters, invisible characters, digits written for letters and markup
 * that renders as nothing can't hide a word. The lab's name is also read with camel-case joins split; the
 * other words are not, so code such as `clientMutationId` stays ordinary.
 */
export function telltales(text: string): string[] {
  const readings = readerViews(text).flatMap((seen) => [seen, ...leetReadings(seen)]);
  const split = readings.map(joinsSplit);
  return TELLTALES.filter(([pattern, reason]) =>
    (reason === LAB_REASON ? [...readings, ...split] : readings).some((reading) => pattern.test(reading)),
  ).map(([, reason]) => reason);
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
  // gives the case away whatever the word list says.
  const ownNames = [template.id, template.invariantId].filter((name): name is string => Boolean(name));
  const named = (text: string) =>
    ownNames.filter((name) => text.toLowerCase().includes(name.toLowerCase())).map((name) => `names ${name}`);
  return fields.flatMap(([field, text]) => [...telltales(text), ...named(text)].map((reason) => `${field}: ${reason}`));
}

/** Qodo's chat commands, as a line's or a quoted value's first word; a path (`/test/x.ts`) is none. */
const QODO_COMMANDS =
  /(^|["'=])\s*\/(ask|review|improve|describe|implement|analyze|test|add_docs|update_changelog|similar_issue|generate_labels|help|help_docs|config|checks|compliance|reflect|reflect_and_review|answer|agentic_\w+|custom_prompt|find_similar|generate_tests|issue|qodo)\b(?![/.-])/im;

/**
 * True when a text addresses Qodo: a mention, or a line that is one of its commands. Qodo learns from every chat in
 * a reviewed repo, which would bias later cases, so nothing posted there may address it.
 */
export function addressesQodo(text: string): boolean {
  return /(^|[^\w.-])@qodo/i.test(text) || QODO_COMMANDS.test(text);
}

export const QODO_REASON =
  "This would address Qodo in a reviewed repo. Chatting with Qodo there teaches it, which would bias later cases: post nothing to it.";

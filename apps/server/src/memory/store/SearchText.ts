const hasBatchim = (ch: string) => {
  const code = ch.charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
};
const hasRieulBatchim = (ch: string) => {
  const code = ch.charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 === 8;
};
const HANGUL_PARTICLE_PATTERN =
  "에게서|한테서|으로부터|로부터|으로서|으로써|으로는|으로도|으로만|에게는|에게도|한테는|한테도|이라고|이라며|이라서|이랑은|이랑도|입니다|입니까|이에요|께서도|께서는|에서도|에서는|께서|에서|에게|한테|으로|로서|로써|로만|로는|로도|부터|까지|마저|조차|이나|이라|이랑|하고|보다|처럼|같이|대로|마다|밖에|커녕|인들|라고|라며|라서|이란|랑은|랑도|예요|이다|이야|은|는|이|가|을|를|의|에|로|와|과|도|만|께|란|랑";
const HANGUL_SUFFIX_RE = new RegExp(
  `^([\\uAC00-\\uD7A3]{2,}?)(?:(님|씨)(?:${HANGUL_PARTICLE_PATTERN})?|(${HANGUL_PARTICLE_PATTERN}))$`,
  "u",
);
const BATCHIM_PARTICLES = new Set([
  "은",
  "이",
  "을",
  "과",
  "으로",
  "으로서",
  "으로써",
  "으로부터",
  "으로는",
  "으로도",
  "으로만",
  "이나",
  "이라",
  "이랑",
  "이라고",
  "이라며",
  "이라서",
  "이란",
  "이랑은",
  "이랑도",
  "이에요",
]);
const VOWEL_PARTICLES = new Set([
  "는",
  "가",
  "를",
  "와",
  "랑",
  "라고",
  "라며",
  "라서",
  "란",
  "랑은",
  "랑도",
  "예요",
]);
const RO_PARTICLES = new Set(["로", "로서", "로써", "로부터", "로는", "로도", "로만"]);
const stripHangulParticle = (word: string) => {
  const match = HANGUL_SUFFIX_RE.exec(word);
  if (!match) return word;
  const [, stem, honorific, bareParticle] = match;
  if (!stem) return word;
  if (honorific) return stem;
  const last = stem[stem.length - 1]!;
  if (bareParticle && BATCHIM_PARTICLES.has(bareParticle)) {
    if (!hasBatchim(last) || (bareParticle.startsWith("으로") && hasRieulBatchim(last)))
      return word;
  } else if (bareParticle && VOWEL_PARTICLES.has(bareParticle)) {
    if (hasBatchim(last)) return word;
  } else if (bareParticle && RO_PARTICLES.has(bareParticle)) {
    if (hasBatchim(last) && !hasRieulBatchim(last)) return word;
  }
  return stem;
};
const ftsQuote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
// unicode61 splits only on whitespace/punctuation, so Hangul nouns stay glued to
// trailing particles in both stored bodies and queries.
export const ftsMatchQuery = (text: string) => {
  const exact = ftsQuote(text);
  if (!/[\uAC00-\uD7A3]/u.test(text)) return exact;
  const clauses = (text.match(/[\p{L}\p{N}_]+/gu) ?? []).map((token) => {
    if (!/[\uAC00-\uD7A3]/u.test(token)) return ftsQuote(token);
    const stemmed = token.replace(/[\uAC00-\uD7A3]+/gu, stripHangulParticle);
    // A one-syllable prefix such as 이 would match nearly every Korean body.
    return stemmed.length < 2 ? ftsQuote(stemmed) : `${ftsQuote(stemmed)}*`;
  });
  if (!clauses.length) return exact;
  const expanded = clauses.length === 1 ? clauses[0]! : `(${clauses.join(" ")})`;
  return `${exact} OR ${expanded}`;
};

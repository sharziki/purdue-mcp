/**
 * A small BM25 index with typo tolerance, prefix matching, and synonym
 * expansion. It exists because BoilerLink's own search is plain lexical OR:
 * "robotcs" returns nothing at all, and "rock climbing" ranks Rock Band
 * alongside the climbing clubs. Both corpora are ~1,500 short documents, so a
 * full local index costs a few megabytes and a few milliseconds.
 */

const STOPWORDS = new Set(
  "a an the and or of for to in on at is are was were be been being we our us you your they their it its this that these those with without as by from will would can could should if then than there here about into over under purdue purdues boilermaker boilermakers".split(
    " ",
  ),
);

/**
 * Campus vocabulary that no amount of string matching bridges: the words a
 * student types are not always the words a club wrote in its mission. Each
 * line is a bidirectional cluster.
 */
const SYNONYMS: string[][] = [
  ["climbing", "climb", "bouldering", "crag", "belay"],
  ["anime", "manga", "cosplay", "otaku"],
  ["coding", "programming", "software", "developer", "hacking", "hackathon", "computing"],
  ["ai", "ml", "machine", "artificial", "intelligence", "neural"],
  ["quant", "quantitative", "trading", "investing", "investment", "finance", "financial", "stocks"],
  ["entrepreneur", "entrepreneurship", "startup", "startups", "founder", "venture"],
  ["frat", "fraternity", "fraternities", "greek", "sorority", "sororities"],
  ["acappella", "cappella", "singing", "choir", "chorus", "vocal"],
  ["gym", "fitness", "lifting", "weightlifting", "powerlifting", "workout", "bodybuilding"],
  ["running", "run", "runner", "track", "marathon"],
  ["gaming", "games", "gamer", "esports", "videogame"],
  ["volunteer", "volunteering", "service", "charity", "philanthropy", "giving", "nonprofit"],
  ["faith", "religious", "religion", "spiritual", "worship", "ministry", "bible"],
  ["dance", "dancing", "dancer", "choreography"],
  ["photo", "photography", "photographer", "film", "cinema", "filmmaking"],
  ["writing", "writers", "literary", "poetry", "journalism", "publication"],
  ["outdoors", "outdoor", "hiking", "camping", "backpacking", "nature"],
  ["environment", "environmental", "sustainability", "sustainable", "climate", "green"],
  ["med", "medical", "medicine", "premed", "health", "healthcare", "nursing"],
  ["law", "legal", "prelaw", "policy", "politics", "political", "government"],
  ["chess", "puzzle", "strategy"],
  ["food", "cooking", "culinary", "baking", "chef"],
  ["car", "cars", "automotive", "motorsport", "racing"],
  ["rocket", "rocketry", "aerospace", "aviation", "flight", "space"],
  ["robot", "robotics", "mechatronics"],
  ["lgbt", "lgbtq", "queer", "pride", "gender", "sexuality"],
  ["mental", "wellness", "wellbeing", "mindfulness", "meditation", "therapy"],
  ["callout", "interest", "info", "informational", "recruitment", "recruiting", "tryout", "tryouts"],
];

const SYNONYM_MAP = (() => {
  const m = new Map<string, string[]>();
  for (const group of SYNONYMS) {
    for (const w of group) {
      m.set(w, [...(m.get(w) ?? []), ...group.filter((o) => o !== w)]);
    }
  }
  return m;
})();

/** Light suffix stripping. Real stemming is not worth a dependency here. */
function stem(w: string): string {
  if (w.length > 5) {
    for (const suf of ["ings", "ing", "ers", "ies", "ed"]) {
      if (w.endsWith(suf)) return suf === "ies" ? `${w.slice(0, -3)}y` : w.slice(0, -suf.length);
    }
  }
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

/** Levenshtein distance, abandoned as soon as it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      best = Math.min(best, row[j]);
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

export type IndexDoc<T> = {
  value: T;
  /** [text, weight] - a hit in a name should outrank a hit in a paragraph. */
  fields: [string | null | undefined, number][];
};

type Posting = { doc: number; tf: number };

export type TextIndex<T> = {
  docs: T[];
  /** Lowercased first field per doc, for exact-name boosts. */
  primary: string[];
  haystack: string[];
  lengths: number[];
  avgLength: number;
  postings: Map<string, Posting[]>;
};

export function buildIndex<T>(input: IndexDoc<T>[]): TextIndex<T> {
  const postings = new Map<string, Posting[]>();
  const lengths: number[] = [];
  const primary: string[] = [];
  const haystack: string[] = [];

  input.forEach((doc, i) => {
    const weighted = new Map<string, number>();
    let length = 0;
    let first = "";
    const all: string[] = [];
    for (const [text, weight] of doc.fields) {
      if (!text) continue;
      if (!first) first = text.toLowerCase().trim();
      all.push(text.toLowerCase());
      for (const token of tokenize(text)) {
        weighted.set(token, (weighted.get(token) ?? 0) + weight);
        length += weight;
      }
    }
    primary.push(first);
    haystack.push(all.join("   "));
    lengths.push(length);
    for (const [token, tf] of weighted) {
      const list = postings.get(token);
      if (list) list.push({ doc: i, tf });
      else postings.set(token, [{ doc: i, tf }]);
    }
  });

  return {
    docs: input.map((d) => d.value),
    primary,
    haystack,
    lengths,
    avgLength: lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1),
    postings,
  };
}

/** A query term plus everything it should also match, each with a confidence. */
function expand<T>(index: TextIndex<T>, term: string): { token: string; weight: number }[] {
  const out = new Map<string, number>();
  const add = (t: string, w: number) => out.set(t, Math.max(out.get(t) ?? 0, w));

  if (index.postings.has(term)) add(term, 1);
  for (const syn of SYNONYM_MAP.get(term) ?? []) {
    const s = stem(syn);
    if (index.postings.has(s)) add(s, 0.65);
  }

  // "robot" should reach "robotics", but "rock" must not reach "rocketry".
  // Requiring the query term to be most of the candidate keeps the expansion
  // to genuine word forms rather than any word that happens to start the same.
  if (term.length >= 4) {
    for (const token of index.postings.keys()) {
      if (token !== term && token.startsWith(term) && term.length / token.length >= 0.6) {
        add(token, 0.6);
      }
    }
  }

  // Typos only when the term itself is unknown - otherwise "read" drags in
  // "real" on every query.
  if (!index.postings.has(term) && term.length >= 4) {
    const max = term.length >= 7 ? 2 : 1;
    let best = max + 1;
    const near: string[] = [];
    for (const token of index.postings.keys()) {
      const d = editDistance(term, token, max);
      if (d > max) continue;
      if (d < best) {
        best = d;
        near.length = 0;
      }
      if (d === best) near.push(token);
    }
    for (const token of near) add(token, best === 1 ? 0.75 : 0.55);
  }

  return [...out].map(([token, weight]) => ({ token, weight }));
}

const K1 = 1.4;
const B = 0.72;

export function searchIndex<T>(
  index: TextIndex<T>,
  query: string,
  limit: number,
): { value: T; score: number }[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];

  const N = index.docs.length;
  const scores = new Float64Array(N);
  const covered: Set<number>[] = terms.map(() => new Set());

  terms.forEach((term, ti) => {
    for (const { token, weight } of expand(index, term)) {
      const list = index.postings.get(token);
      if (!list) continue;
      const idf = Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5));
      for (const { doc, tf } of list) {
        const norm = tf / (tf + K1 * (1 - B + (B * index.lengths[doc]) / index.avgLength));
        scores[doc] += idf * norm * weight;
        covered[ti].add(doc);
      }
    }
  });

  const phrase = query.toLowerCase().trim();
  const multiword = /\s/.test(phrase);

  const ranked: { value: T; score: number }[] = [];
  for (let i = 0; i < N; i++) {
    if (!scores[i]) continue;
    // A doc that matched every query term beats one that matched a single word
    // well. This is what keeps Rock Band out of "rock climbing".
    const hits = covered.reduce((n, set) => n + (set.has(i) ? 1 : 0), 0);
    let score = scores[i] * Math.pow(hits / terms.length, 2);
    if (multiword && index.haystack[i].includes(phrase)) score *= 1.6;
    if (index.primary[i] === phrase) score *= 3;
    else if (index.primary[i].includes(phrase)) score *= 1.5;
    ranked.push({ value: index.docs[i], score });
  }

  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

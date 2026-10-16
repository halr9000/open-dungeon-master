// The passage of a long text that answers a query (issue #302).
//
// A lore entry can run to twenty thousand characters and search_lore used
// to show its first four hundred, which is the heading and the weather. This
// splits a body into passages (paragraphs, or windows of a long paragraph)
// and returns the one the caller's scorer likes best, so the detail the
// model asked about is the detail it reads. The scorer is passed in: the
// search owns its lexical model and this module stays dependency-free.

export const PASSAGE_CHARS = 400;

export function splitPassages(body: string, max = PASSAGE_CHARS): string[] {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!text) {
    return [];
  }
  const out: string[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const flat = paragraph.replace(/\s+/g, " ").trim();
    if (!flat) {
      continue;
    }
    if (flat.length <= max) {
      out.push(flat);
      continue;
    }
    // A long paragraph is walked in windows that end at a sentence when one
    // is near, so a passage reads as prose rather than as a cut.
    let at = 0;
    while (at < flat.length) {
      let end = Math.min(flat.length, at + max);
      if (end < flat.length) {
        const stop = flat.lastIndexOf(". ", end);
        if (stop > at + max / 2) {
          end = stop + 1;
        }
      }
      out.push(flat.slice(at, end).trim());
      at = end;
    }
  }
  return out;
}

// The best passage, or the head when nothing scores: a query that names
// nothing in the text still gets the entry's opening, as before.
export function bestPassage(body: string, score: (passage: string) => number, max = PASSAGE_CHARS): string {
  const passages = splitPassages(body, max);
  if (!passages.length) {
    return "";
  }
  let best = 0;
  let bestScore = 0;
  passages.forEach((passage, index) => {
    const value = score(passage);
    if (value > bestScore) {
      bestScore = value;
      best = index;
    }
  });
  const picked = passages[best];
  return picked.length > max ? `${picked.slice(0, max - 3)}...` : picked;
}

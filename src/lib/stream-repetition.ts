import { endsInsideReasoning } from "@/lib/story-prompt";

// A model stuck in a loop writes the same passage until its output cap,
// which on a local server takes minutes. The guard reads a reply one
// character at a time, so what it decides never depends on where the
// transport cut its chunks, and it keeps a bounded amount of text however
// long the reply runs.
//
// Two shapes count as a loop. Lines are the unit of the first: any newline
// ends one, a literal "\n" as well (that is how a reply wrapped in a JSON
// story object carries its paragraph breaks), and a line holding only
// whitespace is skipped. The loop is the last three cycles of one to six
// lines being identical, with one cycle at least 160 characters long. A
// cycle of several lines must average 40 characters a line and must not be a
// shorter cycle written twice, so a roster or list of identical short entries
// is judged by its one entry and never stacks its way up to 160. The second
// shape has no newline at all: the last N characters of a line equal the N
// before them and the N before those, for some N from 160 to 512.
const MIN_CYCLE_LENGTH = 160;
const MIN_AVERAGE_LINE_LENGTH = 40;
const MAX_PERIOD = 6;
const REPEATS = 3;
// Three cycles of the longest period, and one more to find where a loop
// that began partway through a line started.
const KEPT_LINES = (REPEATS + 1) * MAX_PERIOD;
// A longer line is still read for the second shape, but never matches as a
// line.
const MAX_LINE_LENGTH = 4096;
const MIN_SPAN = 160;
const MAX_SPAN = 512;
const ENDS_KEPT = 2 * MAX_SPAN + 1;

const BACKSLASH = 0x5c;
const NEWLINE = 0x0a;
const RETURN = 0x0d;
const LETTER_N = 0x6e;
const LETTER_R = 0x72;

type Line = { text: string | null; end: number };

export type StreamRepetitionGuard = {
  // Reads the next piece of the reply; true once it has begun repeating, and
  // on every later call.
  push(delta: string): boolean;
  // Where the loop's first copy ends, counted in UTF-16 units from the start
  // of everything pushed, so what precedes it is a reply worth keeping; -1
  // until push has returned true.
  readonly firstCopyEnd: number;
};

export function createStreamRepetitionGuard(): StreamRepetitionGuard {
  let offset = 0;
  let firstCopyEnd = -1;
  let line = "";
  let overflow = false;
  // Just after the last character the current line holds.
  let lineEnd = 0;
  // A backslash waiting on the character after it, and where it ended.
  let escaped = false;
  let backslashEnd = 0;
  const recent: Line[] = [];
  // The second shape, over the current line only: its last MAX_SPAN
  // characters, where each of its last ENDS_KEPT characters ended, and for
  // each span N how many characters in a row have equalled the one N back.
  let count = 0;
  const tail = new Uint16Array(MAX_SPAN);
  const ends = new Float64Array(ENDS_KEPT);
  const runs = new Int32Array(MAX_SPAN + 1);

  const add = (code: number, char: string, end: number): boolean => {
    lineEnd = end;
    if (!overflow) {
      if (line.length < MAX_LINE_LENGTH) line += char;
      else overflow = true;
    }
    const at = count;
    count += 1;
    const widest = Math.min(MAX_SPAN, at);
    for (let span = MIN_SPAN; span <= widest; span += 1) {
      if (tail[(at - span) % MAX_SPAN] === code) {
        runs[span] += 1;
        if (runs[span] >= 2 * span) {
          firstCopyEnd = ends[(at - 2 * span) % ENDS_KEPT];
          return true;
        }
      } else {
        runs[span] = 0;
      }
    }
    tail[at % MAX_SPAN] = code;
    ends[at % ENDS_KEPT] = end;
    return false;
  };

  // Where the loop found at lines first.. began: up to a cycle less one
  // line earlier, and on the line before that when it ends with the loop's
  // opening line (a sentence or a '{"storyText":"' ahead of the first copy).
  const loopStart = (first: number, period: number) => {
    let start = first;
    while (start > 0 && recent[start - 1].text !== null && recent[start - 1].text === recent[start - 1 + period].text) {
      start -= 1;
    }
    const before = start > 0 ? recent[start - 1].text : null;
    const opening = recent[start - 1 + period]?.text;
    if (before && opening && before.length > opening.length && before.endsWith(opening)) {
      start -= 1;
    }
    return start;
  };

  const closeLine = (): boolean => {
    const text = overflow ? null : line.trim();
    const end = lineEnd;
    line = "";
    overflow = false;
    count = 0;
    runs.fill(0);
    if (text === "") {
      return false;
    }
    recent.push({ text, end });
    if (recent.length > KEPT_LINES) {
      recent.shift();
    }
    for (let period = 1; period <= MAX_PERIOD && REPEATS * period <= recent.length; period += 1) {
      const first = recent.length - REPEATS * period;
      const cycle = recent.slice(first, first + period).map((entry) => entry.text);
      if (cycle.some((entry) => entry === null)) continue;
      const lines = cycle as string[];
      const letters = lines.reduce((sum, entry) => sum + entry.length, 0);
      if (letters + period - 1 < MIN_CYCLE_LENGTH) continue;
      if (period > 1 && letters / period < MIN_AVERAGE_LINE_LENGTH) continue;
      if (repeatsShorterCycle(lines)) continue;
      let looping = true;
      for (let index = first + period; index < recent.length && looping; index += 1) {
        looping = recent[index].text === lines[(index - first) % period];
      }
      if (looping) {
        firstCopyEnd = recent[loopStart(first, period) + period - 1].end;
        return true;
      }
    }
    return false;
  };

  return {
    push(delta: string): boolean {
      if (firstCopyEnd >= 0) {
        return true;
      }
      for (let index = 0; index < delta.length; index += 1) {
        const code = delta.charCodeAt(index);
        offset += 1;
        if (escaped) {
          escaped = false;
          if (code === LETTER_N) {
            if (closeLine()) return true;
            continue;
          }
          if (code === LETTER_R) continue;
          // Not an escaped newline: the backslash is text, and so is this
          // character, even another backslash (the pair is one escaped
          // backslash and escapes nothing after it).
          if (add(BACKSLASH, "\\", backslashEnd) || add(code, delta[index], offset)) return true;
          continue;
        }
        if (code === BACKSLASH) {
          escaped = true;
          backslashEnd = offset;
          continue;
        }
        if (code === RETURN) continue;
        if (code === NEWLINE) {
          if (closeLine()) return true;
          continue;
        }
        if (add(code, delta[index], offset)) return true;
      }
      return false;
    },
    get firstCopyEnd() {
      return firstCopyEnd;
    },
  };
}

function repeatsShorterCycle(lines: string[]) {
  for (let period = 1; period < lines.length; period += 1) {
    if (lines.length % period === 0 && lines.every((entry, index) => entry === lines[index % period])) {
      return true;
    }
  }
  return false;
}

// The reply a loop leaves: what was written up to the end of its first copy.
// A reply in the structured story format ({"storyText": "..."}) was cut
// inside its text, so the object is closed again for extractStoryText. Null
// when the copy ends inside a <think> block the server left in the reply:
// that loop is the model's reasoning, and there is no story to keep.
export function firstCopyOf(text: string, end: number): string | null {
  const kept = text.slice(0, end);
  if (endsInsideReasoning(kept)) {
    return null;
  }
  if (kept.trimStart().startsWith("{")) {
    const closed = `${kept}"}`;
    try {
      JSON.parse(closed);
      return closed;
    } catch {
      // Not a story object cut inside its text; kept as written.
    }
  }
  return kept;
}

// A whole reply read at once: undefined when it does not loop, else what
// firstCopyOf keeps of it.
export function cutRepetition(text: string): string | null | undefined {
  const guard = createStreamRepetitionGuard();
  return guard.push(text) ? firstCopyOf(text, guard.firstCopyEnd) : undefined;
}

// How a model call stopped for repeating itself reports it, from every
// backend, so the turn shows one halted notice.
export function streamRepetitionResponse(): Response {
  return Response.json(
    { error: "The model began repeating the same long passage, so generation was stopped. Retry the turn.", code: "stream_repetition" },
    { status: 502 },
  );
}

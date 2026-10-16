// The order of a coordinated plan (issue 292), as steps of character ids,
// first to last; ids sharing a step act at the same time. The moves the
// lead's order controls make (src/app/campaigns/[campaignId]/
// SequenceEditor.tsx) and the checks a sent order passes. The plan itself
// keeps the order on its entries (coordination-logic.ts). Pure, and free of
// alias imports, so scripts/test-coordination.mjs reads it directly.

// Steps of character ids, first to last.
export type PlanSequence = string[][];

// A sequence sent for these characters, cleaned: empty steps dropped. Null
// when it misses a character, names one twice, or names one not in the plan.
export function normalizeSequence(sequence: PlanSequence, ids: string[]): PlanSequence | null {
  const steps = sequence.map((step) => step.filter(Boolean)).filter((step) => step.length);
  const named = steps.flat();
  const wanted = new Set(ids);
  if (named.length !== wanted.size || new Set(named).size !== named.length || named.some((id) => !wanted.has(id))) {
    return null;
  }
  return steps;
}

// A sequence kept to the characters picked now: the ones dropped leave it,
// and the ones added join as steps of their own at the end.
export function fitSequence(sequence: PlanSequence, ids: string[]): PlanSequence {
  const wanted = new Set(ids);
  const kept = sequence.map((step) => step.filter((id) => wanted.has(id))).filter((step) => step.length);
  const placed = new Set(kept.flat());
  return [...kept, ...ids.filter((id) => !placed.has(id)).map((id) => [id])];
}

// The editing moves the order controls make, on steps of ids. Earlier and
// Later move a character one step: alone in its step, the step itself
// swaps with its neighbour; sharing a step, it leaves for a step of its own
// just before or after. With the step above joins the previous step; Own
// step splits a shared one. moveTo is a drop: into a step, or a new step at
// a gap.
function without(sequence: PlanSequence, id: string): PlanSequence {
  return sequence.map((step) => step.filter((entry) => entry !== id));
}

function clean(sequence: PlanSequence): PlanSequence {
  return sequence.filter((step) => step.length);
}

export function moveEarlier(sequence: PlanSequence, id: string): PlanSequence {
  const at = sequence.findIndex((step) => step.includes(id));
  if (at < 0) {
    return sequence;
  }
  if (sequence[at].length > 1) {
    const next = without(sequence, id);
    next.splice(at, 0, [id]);
    return clean(next);
  }
  if (at === 0) {
    return sequence;
  }
  const next = [...sequence];
  [next[at - 1], next[at]] = [next[at], next[at - 1]];
  return next;
}

export function moveLater(sequence: PlanSequence, id: string): PlanSequence {
  const at = sequence.findIndex((step) => step.includes(id));
  if (at < 0) {
    return sequence;
  }
  if (sequence[at].length > 1) {
    const next = without(sequence, id);
    next.splice(at + 1, 0, [id]);
    return clean(next);
  }
  if (at === sequence.length - 1) {
    return sequence;
  }
  const next = [...sequence];
  [next[at], next[at + 1]] = [next[at + 1], next[at]];
  return next;
}

export function joinPrevious(sequence: PlanSequence, id: string): PlanSequence {
  const at = sequence.findIndex((step) => step.includes(id));
  if (at <= 0) {
    return sequence;
  }
  const next = without(sequence, id);
  next[at - 1] = [...next[at - 1], id];
  return clean(next);
}

export function ownStep(sequence: PlanSequence, id: string): PlanSequence {
  const at = sequence.findIndex((step) => step.includes(id));
  if (at < 0 || sequence[at].length < 2) {
    return sequence;
  }
  const next = without(sequence, id);
  next.splice(at + 1, 0, [id]);
  return clean(next);
}

export function moveTo(sequence: PlanSequence, id: string, target: { step: number; join: boolean }): PlanSequence {
  const from = sequence.findIndex((step) => step.includes(id));
  if (from < 0) {
    return sequence;
  }
  const next = without(sequence, id);
  if (target.join) {
    if (!next[target.step]) {
      return sequence;
    }
    next[target.step] = [...next[target.step], id];
  } else {
    next.splice(Math.max(0, Math.min(next.length, target.step)), 0, [id]);
  }
  return clean(next);
}

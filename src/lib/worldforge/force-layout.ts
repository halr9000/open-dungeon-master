// The web's force layout, as an engine that can be run a few steps at a
// time (src/lib/worldforge/web.ts keeps the one-call webLayout on top).
//
// Linked entries pull together, everything pushes apart, and the same world
// always settles the same way (positions start from each ref's hash, not
// from chance), so the web does not jump between visits. It used to keep
// every position in a Map and compare every pair of entries on every one of
// 240 steps, all in one call on the page's main thread: about 70 ms for 100
// entries and 1.7 s for 600, with the page frozen for all of it.
//
// Now positions live in typed arrays; up to EXACT_LIMIT entries the pairs
// are still compared exactly, in the same order with the same arithmetic,
// so a small world lands exactly where it always did. Past that the push is
// summed through a quadtree (Barnes-Hut): a far cluster pushes as one body
// at its centre of mass, which turns the n² pairs into about n log n. And
// the caller can run it in slices (WebView.tsx runs a few steps per frame
// and draws as it settles), dropping a run whose world has changed.
//
// Pure: no DOM, no imports.

export type XY = { x: number; y: number };

// Up to this many entries every pair is compared, exactly as before.
export const EXACT_LIMIT = 160;
// How far a cluster must be, relative to its size, to push as one body.
const THETA = 0.7;
// The quadtree stops dividing here; entries that still share a cell (the
// same point) are kept in a list on that leaf.
const MAX_DEPTH = 24;

export function seeded(ref: string): number {
  let hash = 2166136261;
  for (let i = 0; i < ref.length; i += 1) hash = Math.imul(hash ^ ref.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 10_000) / 10_000;
}

export type ForceRun = {
  readonly total: number;
  readonly done: () => boolean;
  // Runs up to `count` more steps; returns how many ran.
  readonly step: (count: number) => number;
  readonly positions: () => Map<string, XY>;
};

export function startWebLayout(
  nodes: string[],
  edges: Array<{ from: string; to: string }>,
  iterations = 240,
): ForceRun {
  const count = nodes.length;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const seeds = new Float64Array(count);
  const slot = new Map<string, number>();
  nodes.forEach((ref, index) => {
    slot.set(ref, index);
    seeds[index] = seeded(ref);
    const angle = (index / Math.max(1, count)) * Math.PI * 2 + seeds[index] * 0.6;
    const radius = 0.25 + seeded(`${ref}#r`) * 0.2;
    xs[index] = 0.5 + Math.cos(angle) * radius;
    ys[index] = 0.5 + Math.sin(angle) * radius;
  });
  // A ref listed twice moves as one entry, as it did when positions were
  // kept by ref: the later index owns it.
  const owner = Int32Array.from(nodes, (ref) => slot.get(ref)!);

  const live = edges.filter((edge) => slot.has(edge.from) && slot.has(edge.to) && edge.from !== edge.to);
  const from = Int32Array.from(live, (edge) => slot.get(edge.from)!);
  const to = Int32Array.from(live, (edge) => slot.get(edge.to)!);

  const ideal = Math.min(0.3, 0.9 / Math.sqrt(count));
  const pushX = new Float64Array(count);
  const pushY = new Float64Array(count);
  let ran = 0;
  const total = count < 2 ? 0 : iterations;

  // Every pair, in the order the Map version visited them.
  const exactRepulsion = () => {
    const strength = ideal * ideal;
    for (let i = 0; i < count; i += 1) {
      const a = owner[i];
      for (let j = i + 1; j < count; j += 1) {
        const b = owner[j];
        let dx = xs[a] - xs[b];
        let dy = ys[a] - ys[b];
        let distance = Math.hypot(dx, dy);
        if (distance < 1e-4) {
          dx = seeds[i] - 0.5;
          dy = seeds[j] - 0.5;
          distance = Math.hypot(dx, dy) || 1e-4;
        }
        const force = strength / distance;
        pushX[a] += (dx / distance) * force;
        pushY[a] += (dy / distance) * force;
        pushX[b] -= (dx / distance) * force;
        pushY[b] -= (dy / distance) * force;
      }
    }
  };

  // The quadtree, rebuilt each step into flat arrays sized for the worst
  // case (every insert splitting a cell down to MAX_DEPTH is not possible
  // with distinct points; 4 cells per entry plus a margin is plenty, and the
  // arrays grow if a step ever needs more).
  let capacity = Math.max(64, count * 8);
  let cellX = new Float64Array(capacity);
  let cellY = new Float64Array(capacity);
  let cellSize = new Float64Array(capacity);
  let massX = new Float64Array(capacity);
  let massY = new Float64Array(capacity);
  let mass = new Float64Array(capacity);
  let child = new Int32Array(capacity * 4);
  let body = new Int32Array(capacity);
  const nextInCell = new Int32Array(count);
  let cells = 0;

  const grow = () => {
    capacity *= 2;
    const widen = <T extends Float64Array | Int32Array>(old: T, size: number): T => {
      const next = new (old.constructor as { new (n: number): T })(size);
      next.set(old);
      return next;
    };
    cellX = widen(cellX, capacity);
    cellY = widen(cellY, capacity);
    cellSize = widen(cellSize, capacity);
    massX = widen(massX, capacity);
    massY = widen(massY, capacity);
    mass = widen(mass, capacity);
    child = widen(child, capacity * 4);
    body = widen(body, capacity);
  };

  const newCell = (x: number, y: number, size: number) => {
    if (cells >= capacity) grow();
    const cell = cells;
    cells += 1;
    cellX[cell] = x;
    cellY[cell] = y;
    cellSize[cell] = size;
    massX[cell] = 0;
    massY[cell] = 0;
    mass[cell] = 0;
    child[cell * 4] = -1;
    child[cell * 4 + 1] = -1;
    child[cell * 4 + 2] = -1;
    child[cell * 4 + 3] = -1;
    body[cell] = -1;
    return cell;
  };

  const quadrant = (cell: number, b: number) => {
    const half = cellSize[cell] / 2;
    return (xs[b] >= cellX[cell] + half ? 1 : 0) + (ys[b] >= cellY[cell] + half ? 2 : 0);
  };

  const insert = (root: number, b: number) => {
    let cell = root;
    for (let depth = 0; ; depth += 1) {
      // Mass first: every cell on the way down holds this entry.
      const weight = mass[cell];
      massX[cell] = (massX[cell] * weight + xs[b]) / (weight + 1);
      massY[cell] = (massY[cell] * weight + ys[b]) / (weight + 1);
      mass[cell] = weight + 1;
      const isLeaf = child[cell * 4] === -1 && child[cell * 4 + 1] === -1 && child[cell * 4 + 2] === -1 && child[cell * 4 + 3] === -1;
      if (isLeaf) {
        if (body[cell] === -1) {
          body[cell] = b;
          nextInCell[b] = -1;
          return;
        }
        if (depth >= MAX_DEPTH) {
          nextInCell[b] = body[cell];
          body[cell] = b;
          return;
        }
        // Split: the entry already here moves down a level.
        const resident = body[cell];
        body[cell] = -1;
        const half = cellSize[cell] / 2;
        const q = quadrant(cell, resident);
        const sub = newCell(cellX[cell] + (q & 1 ? half : 0), cellY[cell] + (q & 2 ? half : 0), half);
        child[cell * 4 + q] = sub;
        massX[sub] = xs[resident];
        massY[sub] = ys[resident];
        mass[sub] = 1;
        body[sub] = resident;
        nextInCell[resident] = -1;
      }
      const half = cellSize[cell] / 2;
      const q = quadrant(cell, b);
      let next = child[cell * 4 + q];
      if (next === -1) {
        next = newCell(cellX[cell] + (q & 1 ? half : 0), cellY[cell] + (q & 2 ? half : 0), half);
        child[cell * 4 + q] = next;
      }
      cell = next;
    }
  };

  const stack = new Int32Array(MAX_DEPTH * 4 + 8);
  // Math.sqrt rather than Math.hypot here: four times faster, and this path
  // has no older layout to match. The exact path keeps Math.hypot, whose
  // last bits the old layouts depend on.
  const treeRepulsion = () => {
    cells = 0;
    const root = newCell(0, 0, 1);
    for (let index = 0; index < count; index += 1) {
      if (owner[index] === index) insert(root, index);
    }
    const strength = ideal * ideal;
    for (let a = 0; a < count; a += 1) {
      if (owner[a] !== a) continue;
      let top = 0;
      stack[top++] = root;
      while (top > 0) {
        const cell = stack[--top];
        if (mass[cell] === 0) continue;
        const isLeaf = child[cell * 4] === -1 && child[cell * 4 + 1] === -1 && child[cell * 4 + 2] === -1 && child[cell * 4 + 3] === -1;
        if (isLeaf) {
          for (let b = body[cell]; b !== -1; b = nextInCell[b]) {
            if (b === a) continue;
            let dx = xs[a] - xs[b];
            let dy = ys[a] - ys[b];
            let distance = Math.sqrt(dx * dx + dy * dy);
            if (distance < 1e-4) {
              dx = seeds[a] - seeds[b] || seeds[a] - 0.5;
              dy = seeds[b] - 0.5;
              distance = Math.sqrt(dx * dx + dy * dy) || 1e-4;
            }
            const force = strength / distance;
            pushX[a] += (dx / distance) * force;
            pushY[a] += (dy / distance) * force;
          }
          continue;
        }
        const dx = xs[a] - massX[cell];
        const dy = ys[a] - massY[cell];
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > 1e-4 && cellSize[cell] / distance < THETA) {
          const force = (strength * mass[cell]) / distance;
          pushX[a] += (dx / distance) * force;
          pushY[a] += (dy / distance) * force;
          continue;
        }
        for (let q = 0; q < 4; q += 1) {
          const sub = child[cell * 4 + q];
          if (sub !== -1) stack[top++] = sub;
        }
      }
    }
  };

  const iterate = () => {
    const heat = 0.08 * (1 - ran / iterations) + 0.002;
    pushX.fill(0);
    pushY.fill(0);
    if (count <= EXACT_LIMIT) exactRepulsion();
    else treeRepulsion();
    for (let edge = 0; edge < from.length; edge += 1) {
      const a = from[edge];
      const b = to[edge];
      const dx = xs[a] - xs[b];
      const dy = ys[a] - ys[b];
      const distance = Math.hypot(dx, dy) || 1e-4;
      const force = (distance * distance) / ideal;
      pushX[a] -= (dx / distance) * force;
      pushY[a] -= (dy / distance) * force;
      pushX[b] += (dx / distance) * force;
      pushY[b] += (dy / distance) * force;
    }
    for (let index = 0; index < count; index += 1) {
      const p = owner[index];
      // A gentle pull to the middle keeps islands from drifting off.
      pushX[p] += (0.5 - xs[p]) * 0.05;
      pushY[p] += (0.5 - ys[p]) * 0.05;
      const length = Math.hypot(pushX[p], pushY[p]) || 1;
      xs[p] = Math.min(0.97, Math.max(0.03, xs[p] + (pushX[p] / length) * Math.min(length, heat)));
      ys[p] = Math.min(0.97, Math.max(0.03, ys[p] + (pushY[p] / length) * Math.min(length, heat)));
    }
    ran += 1;
  };

  return {
    total,
    done: () => ran >= total,
    step: (steps: number) => {
      let did = 0;
      while (did < steps && ran < total) {
        iterate();
        did += 1;
      }
      return did;
    },
    positions: () => {
      const at = new Map<string, XY>();
      nodes.forEach((ref, index) => at.set(ref, { x: xs[owner[index]], y: ys[owner[index]] }));
      return at;
    },
  };
}

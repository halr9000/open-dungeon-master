// The world web's layout (audit P7): a world of up to EXACT_LIMIT entries
// lands exactly where the original all-pairs layout put it (the reference
// below is that layout, kept verbatim), a bigger one is laid out through
// the quadtree deterministically and inside the frame, and running it in
// slices ends where running it in one call does.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const { EXACT_LIMIT, startWebLayout } = await import("../src/lib/worldforge/force-layout.ts");
const { webLayout } = await import("../src/lib/worldforge/web.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// ---- the original layout, verbatim but for its types ----
function seededRef(ref) {
  let hash = 2166136261;
  for (let i = 0; i < ref.length; i += 1) hash = Math.imul(hash ^ ref.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 10_000) / 10_000;
}

// A force layout in a 0..1 square: linked entries pull together, everything
// pushes apart, and the same world always settles the same way (positions
// start from each ref's hash, not from chance), so the web does not jump
// between visits.
function referenceLayout(nodes, edges, iterations = 240) {
  const count = nodes.length;
  const at = new Map();
  nodes.forEach((ref, index) => {
    const angle = (index / Math.max(1, count)) * Math.PI * 2 + seededRef(ref) * 0.6;
    const radius = 0.25 + seededRef(`${ref}#r`) * 0.2;
    at.set(ref, { x: 0.5 + Math.cos(angle) * radius, y: 0.5 + Math.sin(angle) * radius });
  });
  if (count < 2) return at;
  const ideal = Math.min(0.3, 0.9 / Math.sqrt(count));
  const live = edges.filter((edge) => at.has(edge.from) && at.has(edge.to) && edge.from !== edge.to);
  for (let step = 0; step < iterations; step += 1) {
    const heat = 0.08 * (1 - step / iterations) + 0.002;
    const push = new Map(nodes.map((ref) => [ref, { x: 0, y: 0 }]));
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const a = at.get(nodes[i]);
        const b = at.get(nodes[j]);
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 1e-4) {
          dx = seededRef(nodes[i]) - 0.5;
          dy = seededRef(nodes[j]) - 0.5;
          distance = Math.hypot(dx, dy) || 1e-4;
        }
        const force = (ideal * ideal) / distance;
        const pi = push.get(nodes[i]);
        const pj = push.get(nodes[j]);
        pi.x += (dx / distance) * force;
        pi.y += (dy / distance) * force;
        pj.x -= (dx / distance) * force;
        pj.y -= (dy / distance) * force;
      }
    }
    for (const edge of live) {
      const a = at.get(edge.from);
      const b = at.get(edge.to);
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = Math.hypot(dx, dy) || 1e-4;
      const force = (distance * distance) / ideal;
      const pa = push.get(edge.from);
      const pb = push.get(edge.to);
      pa.x -= (dx / distance) * force;
      pa.y -= (dy / distance) * force;
      pb.x += (dx / distance) * force;
      pb.y += (dy / distance) * force;
    }
    for (const ref of nodes) {
      const p = at.get(ref);
      const d = push.get(ref);
      // A gentle pull to the middle keeps islands from drifting off.
      d.x += (0.5 - p.x) * 0.05;
      d.y += (0.5 - p.y) * 0.05;
      const length = Math.hypot(d.x, d.y) || 1;
      p.x = Math.min(0.97, Math.max(0.03, p.x + (d.x / length) * Math.min(length, heat)));
      p.y = Math.min(0.97, Math.max(0.03, p.y + (d.y / length) * Math.min(length, heat)));
    }
  }
  return at;
}

// Everyone within `hops` links of `center`, for the web around one entry.

// ---- fixtures ----

function world(count, salt = "") {
  const nodes = Array.from({ length: count }, (_, index) => `entity-${salt}${index}`);
  const edges = [];
  for (let index = 1; index < count; index += 1) edges.push({ from: nodes[index - 1], to: nodes[index] });
  for (let index = 0; index < count; index += 5) edges.push({ from: nodes[index], to: nodes[(index * 11 + 3) % count] });
  // A self-link and a link to an entry that is not drawn are ignored.
  if (count > 2) edges.push({ from: nodes[0], to: nodes[0] }, { from: nodes[1], to: "gone" });
  return { nodes, edges };
}

test("a small or medium world lands exactly where it always did", () => {
  for (const count of [0, 1, 2, 3, 12, 40, 99, EXACT_LIMIT]) {
    for (const salt of ["a", "b"]) {
      const { nodes, edges } = world(count, salt);
      const before = referenceLayout(nodes, edges);
      const now = webLayout(nodes, edges);
      assert.equal(now.size, before.size);
      for (const [ref, at] of before) {
        assert.equal(now.get(ref).x, at.x, `${count}${salt} ${ref} x`);
        assert.equal(now.get(ref).y, at.y, `${count}${salt} ${ref} y`);
      }
    }
  }
});

test("a large world is laid out the same way every time, inside the frame", () => {
  const { nodes, edges } = world(700);
  const first = webLayout(nodes, edges);
  const second = webLayout(nodes, edges);
  for (const ref of nodes) {
    const a = first.get(ref);
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y), ref);
    assert.ok(a.x >= 0.03 && a.x <= 0.97 && a.y >= 0.03 && a.y <= 0.97, ref);
    assert.deepEqual(second.get(ref), a);
  }
});

test("linked entries end closer together than the world at large", () => {
  const { nodes, edges } = world(400);
  const at = webLayout(nodes, edges);
  const gap = (a, b) => Math.hypot(at.get(a).x - at.get(b).x, at.get(a).y - at.get(b).y);
  const linked = edges.filter((edge) => at.has(edge.to) && edge.from !== edge.to);
  const meanLinked = linked.reduce((sum, edge) => sum + gap(edge.from, edge.to), 0) / linked.length;
  let total = 0;
  let pairs = 0;
  for (let index = 0; index < nodes.length; index += 7) {
    for (let other = index + 3; other < nodes.length; other += 11) {
      total += gap(nodes[index], nodes[other]);
      pairs += 1;
    }
  }
  assert.ok(meanLinked < (total / pairs) * 0.6, `${meanLinked} vs ${total / pairs}`);
});

test("run in slices, it ends where one call ends", () => {
  for (const count of [50, 300]) {
    const { nodes, edges } = world(count);
    const whole = webLayout(nodes, edges);
    const run = startWebLayout(nodes, edges);
    let slices = 0;
    while (!run.done()) {
      run.step(7);
      slices += 1;
    }
    assert.ok(slices > 1);
    assert.deepEqual(run.positions(), whole);
  }
});

test("a 600-entry world no longer takes seconds", () => {
  const { nodes, edges } = world(600);
  const started = performance.now();
  webLayout(nodes, edges);
  const took = performance.now() - started;
  // About 150 ms on the audit machine (1.7 s before); generous for CI.
  assert.ok(took < 1500, `${Math.round(took)} ms`);
});

console.log(`\n${passed} web-layout tests passed.`);

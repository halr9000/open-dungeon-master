// The board's hover plate shows the figure's painting large, keeps the face
// chain (an uploaded portrait first), and sits clear of the board's edges.
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
register("./lib/register-jsx.mjs", import.meta.url);
const { TokenPlate } = await import("../src/app/campaigns/[campaignId]/BoardChrome.tsx");

const token = { id: "t1", refId: "e1", kind: "enemy", name: "Ogre Brute", x: 9, y: 1 };
const plate = (more) => renderToStaticMarkup(createElement(TokenPlate, {
  token, boardWidth: 10, boardHeight: 10, footprint: 1,
  face: ["/uploads/portrait.png", "/assets/placeholders/monster.webp"],
  health: "bloodied", conditions: [{ id: "prone", label: "Prone" }], ...more,
}));

const markup = plate();
assert.match(markup, /role="tooltip"/);
assert.match(markup, /pointer-events-none/);
assert.match(markup, /src="\/uploads\/portrait.png"/, "the uploaded portrait wins");
assert.match(markup, /size-\[124px\][^"]*sm:size-\[160px\]/, "the painting is shown large");
for (const text of ["Ogre Brute", "Prone"]) assert.ok(markup.includes(text), text);
assert.match(markup, /left:clamp\(88px, 95%, calc\(100% - 88px\)\)/, "kept off the right edge");
assert.match(markup, /translate:-50% 6px/, "below a figure in the top half");
assert.match(plate({ token: { ...token, y: 8 } }), /translate:-50% calc\(-100% - 6px\)/, "above a figure in the bottom half");
console.log("ok: hover plate shows the portrait large, edge-clamped, above or below the figure");

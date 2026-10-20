// The workshop's place as a URL (src/lib/workshop/links.ts, audit WF-11):
// the tool, WorldForge's view and entry, the record to open and the entry
// to come back to, in one order, empty parts left out.
import assert from "node:assert/strict";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-workshop-links");
const { workshopHref, worldEntryPlace } = await import("../src/lib/workshop/links.ts");

await test("A place is written in one order, with empty parts left out.", () => {
  assert.equal(workshopHref("/workshop/w1", {}), "/workshop/w1");
  assert.equal(workshopHref("/workshop/w1", { system: "cast" }), "/workshop/w1?system=cast");
  assert.equal(
    workshopHref("/workshop/w1", { from: "npc:abc", open: "abc", system: "cast", view: null }),
    "/workshop/w1?system=cast&open=abc&from=npc%3Aabc",
  );
});

await test("A World entry is the wiki with that entry open, and reads back as written.", () => {
  const href = workshopHref("/workshop/w1", worldEntryPlace("lore:x-1"));
  assert.equal(href, "/workshop/w1?system=world&view=wiki&entry=lore%3Ax-1");
  assert.equal(new URL(href, "http://h").searchParams.get("entry"), "lore:x-1");
});

finish();

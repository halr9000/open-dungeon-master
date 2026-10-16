// A character page opened from a workshop's Party tool leads back there
// (PR #307's follow-up). The return path rides in ?from=, so only the
// workshop's own address is taken: anything else falls back to the library.
import assert from "node:assert/strict";

const { workshopReturnPath } = await import("../src/lib/navigation.ts");

assert.equal(workshopReturnPath("/workshop/ws_123?system=party"), "/workshop/ws_123?system=party");
assert.equal(workshopReturnPath("/workshop/abc-DEF_9"), "/workshop/abc-DEF_9");

for (const from of [
  null,
  undefined,
  "",
  "//evil.example/workshop/x",
  "https://evil.example/workshop/x",
  "/admin",
  "/characters",
  "/workshop/../admin",
  "/workshop/x?system=party&next=//evil.example",
  "/workshop/x/../../admin",
  "/workshop/x#top",
  "javascript:alert(1)",
  " /workshop/x",
]) {
  assert.equal(workshopReturnPath(from), null, String(from));
}
console.log("ok: a workshop's Party tool is the only return path a character page takes");

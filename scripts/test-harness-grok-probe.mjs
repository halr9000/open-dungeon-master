// Grok Build's models come from `grok models` (src/lib/harness/adapters/grok.ts).
// A program whose list cannot be read leaves the card with no models and a
// message saying so, never a list written into ODM. Stub programs stand in
// for Grok Build.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";
import { removeTempDir } from "./lib/remove-temp-dir.mjs";

register("./lib/register-alias.mjs", import.meta.url);
const { grokAdapter } = await import("../src/lib/harness/adapters/grok.ts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-grok-probe-test-"));
const env = { PATH: process.env.PATH ?? "", HOME: dir };

let passed = 0;
async function test(name, fn) {
  // The stubs are shell scripts; the probe's Windows path is runProgram's,
  // which the harness suites already run there.
  if (process.platform === "win32") {
    console.log(`skip: ${name} (Windows)`);
    return;
  }
  await fn();
  passed += 1;
  console.log(`ok: ${name}`);
}

// A stub that answers --version as Grok Build does and runs `models` for the
// models command.
function stub(name, models) {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh
case "$1" in
  --version) echo "grok 1.4.0"; exit 0 ;;
  models) ${models} ;;
esac
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

await test("a models command that fails gives no models and says the list could not be read", async () => {
  const status = await grokAdapter.probe(stub("grok-fails", `echo "error: unexpected failure" >&2; exit 1`), env);
  assert.equal(status.installed, true);
  assert.deepEqual(status.models, []);
  assert.match(status.message ?? "", /Could not read Grok Build's model list/);
});

await test("a models command that prints nothing gives no models and the same message", async () => {
  const status = await grokAdapter.probe(stub("grok-silent", "exit 0"), env);
  assert.deepEqual(status.models, []);
  assert.match(status.message ?? "", /Could not read Grok Build's model list/);
});

await test("a listed model is what the card offers, with no message", async () => {
  const status = await grokAdapter.probe(stub("grok-lists", `echo "Logged in."; echo "  - grok-test-a"; echo "  - grok-test-b"`), env);
  assert.deepEqual(status.models.map((model) => model.id), ["grok-test-a", "grok-test-b"]);
  assert.equal(status.message, undefined);
});

await test("signed out says so, not that the list was unreadable", async () => {
  const status = await grokAdapter.probe(stub("grok-signed-out", `echo "Not logged in. Run grok login." >&2; exit 1`), env);
  assert.equal(status.auth.state, "signed-out");
  assert.match(status.message ?? "", /not signed in/);
});

removeTempDir(dir);
console.log(`${passed} grok probe tests passed`);

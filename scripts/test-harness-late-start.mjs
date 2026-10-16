// A program that is still starting when its turn times out (src/lib/harness/
// bridge.ts): the session closes with nothing to close, so the program that
// arrives afterwards must be closed then and there, and never sent the
// prompt. Before, it was attached and prompted, and nothing ever closed it.
// opencode's start can take over a minute (server, agent, MCP), so a short
// turn timeout meets it. The fake adapter stands in, made slow to start.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odm-harness-late-"));
process.env.SQLITE_DB_PATH = path.join(dir, "test.sqlite");
process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.HARNESS_FAKE = "1";
register("./lib/register-alias.mjs", import.meta.url);

const { saveGlobalConfig } = await import("../src/lib/db/app-settings.ts");
const { activeBridgeSessions, requestHarnessMessage } = await import("../src/lib/harness/bridge.ts");
const { fakeAdapter } = await import("../src/lib/harness/adapters/fake.ts");
const { removeTempDir } = await import("./lib/remove-temp-dir.mjs");

saveGlobalConfig({ harness: { id: "claude", model: "haiku", maxConcurrent: 2, turnTimeoutSec: 60 }, text: { provider: "harness" } });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const heard = [];
const realStart = fakeAdapter.start;
fakeAdapter.start = async () => {
  await sleep(600);
  return {
    send: () => heard.push("send"),
    close: () => heard.push("close"),
  };
};

try {
  const rollTool = {
    type: "function",
    function: { name: "request_roll", description: "Roll.", parameters: { type: "object", properties: {} } },
  };
  const result = await requestHarnessMessage(
    [
      { role: "system", content: "You are the DM." },
      { role: "user", content: "I open the door." },
    ],
    { tools: [rollTool], timeoutMs: 200 },
    { role: "story", turn: true },
  );
  assert.equal(result.error?.status, 504, "the turn timed out while the program was starting");
  assert.equal(activeBridgeSessions(), 0);
  await sleep(700);
  assert.deepEqual(heard, ["close"], "closed as soon as it arrived, and never prompted");
} finally {
  fakeAdapter.start = realStart;
}
removeTempDir(dir);
console.log("harness late start: a program that starts after its turn timed out is closed, not prompted");

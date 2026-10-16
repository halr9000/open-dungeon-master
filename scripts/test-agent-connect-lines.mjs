// The one line Settings > Connected agents and the guided setup give each
// program (src/components/AgentConnectLines.tsx). opencode's is in opencode
// 2's shape, which its GET /api/config reports back as written (2.0.27):
// the servers under `mcp.servers`.
import assert from "node:assert/strict";
import { register } from "node:module";

register("./lib/register-jsx.mjs", import.meta.url);
const { agentSetupLine } = await import("../src/components/AgentConnectLines.tsx");

const url = "http://192.168.1.20:3005/api/mcp";
const token = "odm_tok_123";

const opencode = agentSetupLine("opencode", url, token);
assert.deepEqual(JSON.parse(`{${opencode.text}}`), {
  mcp: { servers: { odm: { type: "remote", url, headers: { Authorization: `Bearer ${token}` }, oauth: false } } },
});
assert.match(opencode.where, /opencode 2/);
assert.match(agentSetupLine("claude", url, token).text, /^claude mcp add --transport http odm http:\/\/192\.168\.1\.20:3005\/api\/mcp --header "Authorization: Bearer odm_tok_123"$/);
assert.match(agentSetupLine("codex", url, token).text, /^\[mcp_servers\.odm\]\nurl = "http:\/\/192\.168\.1\.20:3005\/api\/mcp"\n/);
assert.ok(agentSetupLine("other", url, token).text.includes(`Bearer ${token}`));
console.log("ok: each program's connect line, opencode's in opencode 2's shape");

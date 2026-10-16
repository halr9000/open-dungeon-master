// A stand-in for `opencode serve` (2.x), for scripts/test-harness-opencode-run.mjs.
// It answers the routes the adapter uses (src/lib/harness/adapters/opencode.ts)
// with the shapes opencode 2.0.27 answers them with, and records every request
// to ODM_FAKE_OPENCODE_LOG, one JSON line each. What it holds comes from the
// JSON file at ODM_FAKE_OPENCODE:
//
//   sessions       what GET /api/session lists
//   deleteStatus   the status DELETE /api/session/:id answers (404 = gone)
//   models         what GET /api/model lists
//   defaultModel   what GET /api/model/default answers (opencode's default)
//   events         sent on the event stream once a prompt arrives: objects
//                  as JSON, strings as they are
//
// ODM's agent and its rules come from the run's config, read from
// opencode.json in OPENCODE_CONFIG_DIR alone.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const log = (entry) => fs.appendFileSync(process.env.ODM_FAKE_OPENCODE_LOG, `${JSON.stringify(entry)}\n`);
const scenario = JSON.parse(fs.readFileSync(process.env.ODM_FAKE_OPENCODE, "utf8"));
const configFile = path.join(process.env.OPENCODE_CONFIG_DIR ?? "", "opencode.json");
const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
log({
  start: {
    config,
    mode: fs.existsSync(configFile) ? fs.statSync(configFile).mode & 0o777 : null,
    configInEnvironment: "OPENCODE_CONFIG_CONTENT" in process.env,
  },
});

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const streams = [];
const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

http
  .createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    const url = new URL(req.url, "http://127.0.0.1");
    log({ method: req.method, url: req.url, ...(body === undefined ? {} : { body }) });
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": heartbeat\n\n");
      streams.push(res);
      return;
    }
    if (route === "GET /api/session") {
      return json(res, 200, { data: scenario.sessions ?? [], cursor: { previous: null, next: null } });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/session/")) {
      const status = scenario.deleteStatus ?? 200;
      return json(res, status, status === 404 ? { _tag: "SessionNotFoundError" } : status === 200 ? { data: true } : { _tag: "InternalError" });
    }
    if (route === `GET /api/agent/odm-dm`) {
      const agent = config.agents?.["odm-dm"];
      if (!agent) {
        return json(res, 404, { _tag: "AgentNotFoundError" });
      }
      // opencode's own defaults come first, then the config's rules.
      return json(res, 200, { data: { id: "odm-dm", system: agent.system, permissions: [{ action: "*", resource: "*", effect: "allow" }, ...(agent.permissions ?? [])] } });
    }
    if (route === "GET /api/model") {
      return json(res, 200, { data: scenario.models ?? [] });
    }
    if (route === "GET /api/model/default") {
      return json(res, 200, { data: scenario.defaultModel ?? null });
    }
    if (route === "POST /api/session") {
      return json(res, 200, { data: { id: "ses_fake" } });
    }
    if (route === "GET /api/mcp") {
      return json(res, 200, { data: [{ name: "odm", status: { status: "connected" } }] });
    }
    if (route === "POST /api/session/ses_fake/prompt") {
      json(res, 200, { data: {} });
      for (const event of scenario.events ?? []) {
        for (const stream of streams) {
          stream.write(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);
        }
      }
      return;
    }
    if (route === "POST /api/session/ses_fake/interrupt") {
      return json(res, 200, { data: {} });
    }
    json(res, 404, { _tag: "NotFound" });
  })
  .listen(port, "127.0.0.1", () => console.log(`opencode server listening on http://127.0.0.1:${port}`));

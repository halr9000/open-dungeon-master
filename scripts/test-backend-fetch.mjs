// The backend fetch (src/lib/backend-fetch.ts): a connection the other side
// drops before answering is retried once on a fresh socket; a second drop,
// a refusal and a caller's abort are not.
import assert from "node:assert/strict";
import http from "node:http";
import { register } from "node:module";

register("./lib/register-alias.mjs", import.meta.url);

const { connectionDropped, fetchBackend } = await import("../src/lib/backend-fetch.ts");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok: ${name}`);
}

// A server that destroys the socket of the first `drops` requests, then
// answers.
async function flaky(drops) {
  let seen = 0;
  const server = http.createServer((req, res) => {
    seen += 1;
    if (seen <= drops) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ seen }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, close: () => server.close(), seen: () => seen };
}

await test("a connection dropped before any reply is asked again once", async () => {
  const server = await flaky(1);
  try {
    const response = await fetchBackend(server.url, { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { seen: 2 });
  } finally {
    server.close();
  }
});

await test("a second drop is the backend's answer, not a loop", async () => {
  const server = await flaky(5);
  try {
    await assert.rejects(fetchBackend(server.url, { method: "POST", body: "{}" }));
    assert.equal(server.seen(), 2, "one retry, no more");
  } finally {
    server.close();
  }
});

await test("a caller's abort is not retried", async () => {
  const server = await flaky(5);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fetchBackend(server.url, { method: "POST", body: "{}", signal: controller.signal }), /abort/i);
    assert.equal(server.seen(), 0);
  } finally {
    server.close();
  }
});

await test("only a dropped connection counts, however deep undici buried it", () => {
  assert.equal(connectionDropped(new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) })), true);
  assert.equal(connectionDropped(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), true);
  assert.equal(connectionDropped(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) })), false, "a server that is down is down");
  assert.equal(connectionDropped(new DOMException("This operation was aborted", "AbortError")), false);
  assert.equal(connectionDropped(null), false);
});

console.log(`backend fetch: ${passed} tests passed`);

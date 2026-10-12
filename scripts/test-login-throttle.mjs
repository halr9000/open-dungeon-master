// Assert-based tests for the login throttle. Run via: npm test
import assert from "node:assert/strict";
import {
  checkLogin,
  checkPasswordAttempt,
  clientIp,
  recordLoginFailure,
  recordPasswordFailure,
  recordPasswordSuccess,
  recordLoginSuccess,
  throttleKey,
  throttleSize,
} from "../src/lib/login-throttle.ts";

let passed = 0;
function test(name, fn) {
  globalThis.__odmLoginThrottle = new Map();
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const MIN = 60 * 1000;

test("key normalizes username case and trims", () => {
  assert.equal(throttleKey(" Alice ", "10.0.0.5"), "alice|10.0.0.5");
});

test("first four failures do not block", () => {
  const key = "alice|local";
  for (let i = 0; i < 4; i += 1) {
    recordLoginFailure(key, i * 1000);
    assert.equal(checkLogin(key, i * 1000).blocked, false);
  }
});

test("fifth failure inside the window blocks for 60s", () => {
  const key = "alice|local";
  for (let i = 0; i < 5; i += 1) {
    recordLoginFailure(key, i * 1000);
  }
  const gate = checkLogin(key, 5000);
  assert.equal(gate.blocked, true);
  assert.ok(gate.retryAfterSec > 0 && gate.retryAfterSec <= 60);
  assert.equal(checkLogin(key, 4000 + MIN + 1).blocked, false);
});

test("lockout doubles on repeated bursts and caps at 15 minutes", () => {
  const key = "alice|local";
  let now = 0;
  let lastLockoutMs = 0;
  for (let burst = 0; burst < 6; burst += 1) {
    for (let i = 0; i < 5; i += 1) {
      recordLoginFailure(key, now);
    }
    const gate = checkLogin(key, now);
    assert.equal(gate.blocked, true);
    const lockoutMs = gate.retryAfterSec * 1000;
    assert.ok(lockoutMs >= lastLockoutMs, "lockout never shrinks across bursts");
    assert.ok(lockoutMs <= 15 * MIN, "lockout capped at 15 minutes");
    lastLockoutMs = lockoutMs;
    now += lockoutMs + 1000;
  }
  assert.equal(lastLockoutMs, 15 * MIN);
});

test("failures outside the 15 minute window are forgotten", () => {
  const key = "alice|local";
  for (let i = 0; i < 4; i += 1) {
    recordLoginFailure(key, i * 1000);
  }
  recordLoginFailure(key, 16 * MIN);
  assert.equal(checkLogin(key, 16 * MIN).blocked, false);
});

test("success clears the slate", () => {
  const key = "alice|local";
  for (let i = 0; i < 4; i += 1) {
    recordLoginFailure(key, i * 1000);
  }
  recordLoginSuccess(key);
  recordLoginFailure(key, 10_000);
  assert.equal(checkLogin(key, 10_000).blocked, false);
});

test("keys are independent per ip", () => {
  for (let i = 0; i < 5; i += 1) {
    recordLoginFailure("alice|10.0.0.5", i * 1000);
  }
  assert.equal(checkLogin("alice|10.0.0.5", 5000).blocked, true);
  assert.equal(checkLogin("alice|10.0.0.6", 5000).blocked, false);
});

test("stale unblocked entries are pruned on check", () => {
  recordLoginFailure("alice|local", 0);
  checkLogin("bob|local", 16 * MIN);
  assert.equal(globalThis.__odmLoginThrottle.has("alice|local"), false);
});

test("a guesser who sends a new address with every try still runs out of tries", () => {
  // Reached directly, the address is whatever the caller's header says.
  for (let i = 0; i < 19; i += 1) {
    assert.equal(checkPasswordAttempt("alice", `10.0.0.${i}`, i * 1000).blocked, false, `try ${i + 1}`);
    recordPasswordFailure("alice", `10.0.0.${i}`, i * 1000);
  }
  recordPasswordFailure("alice", "10.0.0.19", 19_000);
  const gate = checkPasswordAttempt("alice", "10.0.0.200", 20_000);
  assert.equal(gate.blocked, true);
  assert.ok(gate.retryAfterSec > 0 && gate.retryAfterSec <= 60);
  // Another account is untouched, and the lock lifts.
  assert.equal(checkPasswordAttempt("bob", "10.0.0.200", 20_000).blocked, false);
  assert.equal(checkPasswordAttempt("alice", "10.0.0.200", 19_000 + MIN + 1).blocked, false);
});

test("one person mistyping from one place meets the short lock first, as before", () => {
  for (let i = 0; i < 5; i += 1) {
    recordPasswordFailure("alice", "10.0.0.5", i * 1000);
  }
  assert.equal(checkPasswordAttempt("alice", "10.0.0.5", 5000).blocked, true);
  assert.equal(checkPasswordAttempt("alice", "10.0.0.6", 5000).blocked, false);
});

test("a good login clears that address's count, never the account's", () => {
  for (let i = 0; i < 4; i += 1) {
    recordPasswordFailure("alice", "10.0.0.5", i * 1000);
  }
  recordPasswordSuccess("alice", "10.0.0.5");
  assert.equal(globalThis.__odmLoginThrottle.has("alice|10.0.0.5"), false);
  assert.equal(globalThis.__odmLoginThrottle.get("account:alice").failures.length, 4);
});

test("one address trying a new name every time still runs out of tries", () => {
  for (let i = 0; i < 49; i += 1) {
    assert.equal(checkPasswordAttempt(`name${i}`, "203.0.113.9", i * 100).blocked, false, `try ${i + 1}`);
    recordPasswordFailure(`name${i}`, "203.0.113.9", i * 100);
  }
  recordPasswordFailure("name49", "203.0.113.9", 4_900);
  assert.equal(checkPasswordAttempt("somebody-new", "203.0.113.9", 5_000).blocked, true);
  // Another address, and the real owner of any of those names, are not held up.
  assert.equal(checkPasswordAttempt("somebody-new", "203.0.113.10", 5_000).blocked, false);
});

test("callers with no address of their own never share one bucket", () => {
  for (let i = 0; i < 80; i += 1) {
    recordPasswordFailure(`name${i}`, "local", i * 100);
  }
  assert.equal(checkPasswordAttempt("anyone", "local", 8_100).blocked, false);
  assert.equal(globalThis.__odmLoginThrottle.has("source:local"), false);
});

test("the remembered keys stop at a ceiling, lockouts kept longest", () => {
  // A lockout first, then a spray of names that would grow the map forever.
  for (let i = 0; i < 5; i += 1) {
    recordLoginFailure("victim|10.0.0.1", i);
  }
  for (let i = 0; i < 10_500; i += 1) {
    recordLoginFailure(`spray${i}|10.9.9.9`, 1_000 + i);
  }
  assert.ok(throttleSize() <= 10_000, `size ${throttleSize()}`);
  assert.equal(checkLogin("victim|10.0.0.1", 12_000).blocked, true);
});

test("TRUST_PROXY_HEADERS=0 ignores forwarding headers", () => {
  const request = new Request("http://x/", {
    headers: { "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "1.2.3.4, 198.51.100.2" },
  });
  assert.equal(clientIp(request), "198.51.100.1");
  process.env.TRUST_PROXY_HEADERS = "0";
  try {
    assert.equal(clientIp(request), "local");
  } finally {
    delete process.env.TRUST_PROXY_HEADERS;
  }
});

console.log(`\n${passed} login-throttle tests passed.`);

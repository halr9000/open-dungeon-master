// Per-username+IP login throttle: after 5 failures inside a 15 minute
// window the pair is locked out for 60s, doubling on each further lockout
// up to 15 minutes. Pure logic with caller-supplied timestamps so the test
// harness can drive the clock; state lives on globalThis to survive dev HMR
// reloads (same pattern as the DM queue).

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const BASE_LOCKOUT_MS = 60 * 1000;
const MAX_LOCKOUT_MS = 15 * 60 * 1000;

type ThrottleEntry = {
  failures: number[];
  lockouts: number;
  blockedUntil: number;
};

declare global {
  var __odmLoginThrottle: Map<string, ThrottleEntry> | undefined;
}

function store(): Map<string, ThrottleEntry> {
  if (!globalThis.__odmLoginThrottle) {
    globalThis.__odmLoginThrottle = new Map();
  }
  return globalThis.__odmLoginThrottle;
}

export function throttleKey(username: string, ip: string) {
  return `${username.trim().toLowerCase()}|${ip}`;
}

// The map is swept at most this often, not on every check: a sweep walks
// every entry, and a burst of attempts used to pay for one each.
const PRUNE_EVERY_MS = 30 * 1000;
// A hard ceiling on remembered keys. Past it the stalest are forgotten,
// lockouts last, so a caller spraying made-up names cannot grow this process
// without bound.
const MAX_ENTRIES = 10_000;
let lastPrune = 0;

function stale(entry: ThrottleEntry, now: number) {
  const lastFailure = entry.failures[entry.failures.length - 1] ?? 0;
  return entry.blockedUntil <= now && now - lastFailure > WINDOW_MS;
}

function prune(now: number, force = false) {
  if (!force && now - lastPrune < PRUNE_EVERY_MS && now >= lastPrune) {
    return;
  }
  lastPrune = now;
  for (const [key, entry] of store()) {
    if (stale(entry, now)) {
      store().delete(key);
    }
  }
}

function enforceCeiling(now: number) {
  if (store().size <= MAX_ENTRIES) {
    return;
  }
  prune(now, true);
  // Oldest first (a Map keeps insertion order and an update re-inserts),
  // keys that are not locked out before any that are.
  for (const pass of [false, true]) {
    for (const [key, entry] of store()) {
      if (store().size <= MAX_ENTRIES) {
        return;
      }
      if (pass || entry.blockedUntil <= now) {
        store().delete(key);
      }
    }
  }
}

export function throttleSize(): number {
  return store().size;
}

export function checkLogin(key: string, now = Date.now()): { blocked: boolean; retryAfterSec: number } {
  prune(now);
  const entry = store().get(key);
  if (!entry || entry.blockedUntil <= now) {
    return { blocked: false, retryAfterSec: 0 };
  }
  return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)) };
}

export function recordLoginFailure(key: string, now = Date.now(), maxFailures = MAX_FAILURES) {
  const entry = store().get(key) ?? { failures: [], lockouts: 0, blockedUntil: 0 };
  entry.failures = entry.failures.filter((at) => now - at <= WINDOW_MS);
  entry.failures.push(now);
  if (entry.failures.length >= maxFailures) {
    const lockoutMs = Math.min(BASE_LOCKOUT_MS * 2 ** entry.lockouts, MAX_LOCKOUT_MS);
    entry.lockouts += 1;
    entry.blockedUntil = now + lockoutMs;
    entry.failures = [];
  }
  // Re-inserted so the map's order is least recently failed first.
  store().delete(key);
  store().set(key, entry);
  enforceCeiling(now);
}

export function recordLoginSuccess(key: string) {
  store().delete(key);
}

// A password attempt is counted twice: against the name from this address,
// and against the name from anywhere. The address is only as honest as
// whatever sits in front of the server (see clientIp): reached directly, a
// caller can send a new made-up address with every guess and never fill the
// first bucket. The second does not care where a guess came from. Its limit
// is higher, so one person mistyping from one place meets the first lock
// long before this one, and it is not cleared by a good login, so a guesser
// cannot have the owner's own sign-in reset the count.
const ACCOUNT_MAX_FAILURES = 20;

function accountKey(username: string) {
  return `account:${username.trim().toLowerCase()}`;
}

// And a third count, by address alone: a caller who tries a new name with
// every guess never fills either bucket above, but still pays a password
// hash each time. Only kept when the address means something; a server with
// no proxy in front sees every caller as "local", and one shared bucket
// would let anybody lock everybody out.
const SOURCE_MAX_FAILURES = 50;

function sourceKey(ip: string): string | null {
  return ip && ip !== "local" ? `source:${ip}` : null;
}

export function checkPasswordAttempt(
  username: string,
  ip: string,
  now = Date.now(),
): { blocked: boolean; retryAfterSec: number } {
  const here = checkLogin(throttleKey(username, ip), now);
  const anywhere = checkLogin(accountKey(username), now);
  const source = sourceKey(ip);
  const fromThere = source ? checkLogin(source, now) : { blocked: false, retryAfterSec: 0 };
  return {
    blocked: here.blocked || anywhere.blocked || fromThere.blocked,
    retryAfterSec: Math.max(here.retryAfterSec, anywhere.retryAfterSec, fromThere.retryAfterSec),
  };
}

export function recordPasswordFailure(username: string, ip: string, now = Date.now()) {
  recordLoginFailure(throttleKey(username, ip), now);
  recordLoginFailure(accountKey(username), now, ACCOUNT_MAX_FAILURES);
  const source = sourceKey(ip);
  if (source) {
    recordLoginFailure(source, now, SOURCE_MAX_FAILURES);
  }
}

export function recordPasswordSuccess(username: string, ip: string) {
  recordLoginSuccess(throttleKey(username, ip));
}

// The address a request came from, for the per-address throttles. Behind
// Cloudflare the edge states it outright; behind one reverse proxy the LAST
// x-forwarded-for entry is the one the proxy appended, while the first is
// whatever the client chose to send (which is how a caller used to dodge
// the lockout by rotating a made-up header). With no proxy at all the
// header is absent and every caller shares one bucket, as before.
//
// A server reached directly cannot tell a proxy's header from one the
// caller typed, so this address is a hint and never the only limit on a
// password guess (checkPasswordAttempt counts by account as well). Such a
// server can say so with TRUST_PROXY_HEADERS=0: the headers are then
// ignored and every caller is "local", which also turns the per-address
// bucket off rather than letting a caller pick its own address.
export function clientIp(request: Request): string {
  if (process.env.TRUST_PROXY_HEADERS === "0") {
    return "local";
  }
  const edge = request.headers.get("cf-connecting-ip")?.trim();
  if (edge) return edge;
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return forwarded?.length ? forwarded[forwarded.length - 1] : "local";
}

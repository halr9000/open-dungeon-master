import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { fillUsageScope, openUsageScope, type UsageScope } from "@/lib/usage/scope";
import { cookies, headers } from "next/headers";
import {
  deleteSession,
  getSessionUser,
  insertSession,
  type User,
} from "@/lib/db/users";
import { serverEnv } from "@/lib/server-env";

export const SESSION_COOKIE = "odm_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SCRYPT_KEYLEN = 64;

// Password hashing runs on libuv's thread pool, not the event loop: a
// synchronous scrypt held every other request and every live stream for
// about 20 ms per attempt, so a burst of guesses slowed the whole table.
// The work factor is Node's default and is not lowered for speed.
//
// At most PASSWORD_WORKERS hashes run at once and PASSWORD_QUEUE wait; past
// that an attempt is turned away (PasswordBusyError, a 503 with Retry-After)
// before any hashing, so a flood costs a refusal rather than memory and CPU.
const PASSWORD_WORKERS = 2;
const PASSWORD_QUEUE = 32;
let passwordRunning = 0;
const passwordWaiting: Array<() => void> = [];

export class PasswordBusyError extends Error {
  constructor() {
    super("Too many sign-ins at once. Try again in a moment.");
  }
}

async function passwordSlot(): Promise<void> {
  if (passwordRunning < PASSWORD_WORKERS) {
    passwordRunning += 1;
    return;
  }
  if (passwordWaiting.length >= PASSWORD_QUEUE) {
    throw new PasswordBusyError();
  }
  // The slot is handed over by releasePasswordSlot, already counted.
  await new Promise<void>((resolve) => passwordWaiting.push(resolve));
}

function releasePasswordSlot() {
  const next = passwordWaiting.shift();
  if (next) {
    next();
  } else {
    passwordRunning -= 1;
  }
}

function scryptAsync(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

async function boundedScrypt(password: string, salt: string): Promise<Buffer> {
  await passwordSlot();
  try {
    return await scryptAsync(password, salt);
  } finally {
    releasePasswordSlot();
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await boundedScrypt(password, salt)).toString("hex");
  return `${salt}$${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split("$");
  if (!salt || !hash) {
    return false;
  }
  const candidate = await boundedScrypt(password, salt);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// Unknown usernames still pay one scrypt verification against this hash so
// response timing does not reveal whether an account exists. Made once, on
// first use.
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword("odm-dummy-password").catch((error) => {
    dummyHash = null;
    throw error;
  });
  return dummyHash;
}

// What a password route answers when the hashing queue is full.
export function passwordBusyResponse(): Response {
  return Response.json(
    { error: new PasswordBusyError().message },
    { status: 503, headers: { "Retry-After": "2" } },
  );
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// Secure flag for auth cookies: COOKIE_SECURE=1/0 overrides; otherwise on
// whenever the request arrived over https (reverse proxy sets the header).
// Plain LAN http keeps working with the flag off.
export async function cookieSecure(): Promise<boolean> {
  const override = serverEnv("COOKIE_SECURE");
  if (override === "1") return true;
  if (override === "0") return false;
  const proto = ((await headers()).get("x-forwarded-proto") ?? "").split(",")[0].trim();
  return proto === "https";
}

// Reads the token native client apps send instead of the browser cookie.
// Cookie and bearer sessions are the same rows in the sessions table; only
// the transport differs.
async function bearerToken(): Promise<string | null> {
  const header = (await headers()).get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

async function requestToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value ?? (await bearerToken());
}

// Creates a session row and returns the raw token without touching cookies:
// the caller (a native app via /api/auth/token) stores it itself.
export function mintSession(userId: string): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  insertSession(hashToken(token), userId, expiresAt.toISOString());
  return { token, expiresAt: expiresAt.toISOString() };
}

export async function startSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  insertSession(hashToken(token), userId, expiresAt.toISOString());

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: await cookieSecure(),
    path: "/",
    expires: expiresAt,
  });
}

export async function endSession() {
  const token = await requestToken();
  if (token) {
    deleteSession(hashToken(token));
  }
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

// Hash of the caller's session token, so password changes can revoke every
// other session while keeping this one alive.
export async function currentSessionTokenHash(): Promise<string | null> {
  const token = await requestToken();
  return token ? hashToken(token) : null;
}

// Returns the logged-in user, or null. Route handlers that require auth
// should 401 on null. Accepts the browser cookie or a bearer token.
//
// The usage scope is opened here, before the first await, and filled in
// once the account is known (src/lib/usage/scope.ts openUsageScope);
// requireMember passes the one it opened.
export async function currentUser(scope: UsageScope = openUsageScope()): Promise<User | null> {
  const token = await requestToken();
  if (!token) {
    return null;
  }
  const user = getSessionUser(hashToken(token));
  if (user) {
    // Work this request does outside any campaign (a library portrait,
    // dictation, an upload) is the account's in the usage ledger and its
    // record of who made which file.
    fillUsageScope(scope, { userId: user.id });
  }
  return user;
}

export function unauthorized() {
  return Response.json({ error: "Not logged in." }, { status: 401 });
}

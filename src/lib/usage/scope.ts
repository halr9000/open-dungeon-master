import { AsyncLocalStorage } from "node:async_hooks";

// Who a piece of AI work is for, carried down the async call chain so the
// usage ledger (src/lib/usage/ledger.ts) and the shared-host policy
// (src/lib/shared-host.ts) can read it without every model, image and
// speech call threading a campaign id through its arguments.
//
// Opened once per request by currentUser (the account) and requireMember
// (the campaign), re-entered by the DM and media queues for the jobs they
// run later, so a picture painted a minute after the turn still lands on
// the campaign's row (issue #137).
export type UsageScope = { campaignId?: string; userId?: string };

const storage = new AsyncLocalStorage<UsageScope>();

export function currentUsageScope(): UsageScope {
  return storage.getStore() ?? {};
}

// Scopes a request opened (openUsageScope) and fills in as it learns more.
const opened = new WeakSet<UsageScope>();

// Enters a scope now and hands it back to be filled in later. A helper the
// route awaits (currentUser, requireMember) learns who the request is for
// only after an await of its own, and a scope entered there does not reach
// the route under Next, which resumes parts of a request in context
// snapshots: an upload was recorded as nobody's, so its maker could not
// open it (src/lib/media-access.ts). Opened before that first await, while
// the route's own context is still the current one, the scope is the
// route's; filling it in reaches it by reference wherever the helper
// resumes.
export function openUsageScope(): UsageScope {
  const scope: UsageScope = { ...currentUsageScope() };
  opened.add(scope);
  storage.enterWith(scope);
  return scope;
}

export function fillUsageScope(scope: UsageScope, patch: UsageScope): void {
  Object.assign(scope, withoutBlanks(patch));
}

// Adds to the scope for the rest of the current async context: the route
// handler that called it and everything it awaits. A scope the request
// opened is filled in place, for the reason above.
export function enterUsageScope(patch: UsageScope): void {
  const current = storage.getStore();
  if (current && opened.has(current)) {
    fillUsageScope(current, patch);
    return;
  }
  storage.enterWith({ ...currentUsageScope(), ...withoutBlanks(patch) });
}

export function runInUsageScope<T>(scope: UsageScope, fn: () => T): T {
  return storage.run({ ...currentUsageScope(), ...withoutBlanks(scope) }, fn);
}

// Captures the scope now, for a job that runs later from a queue whose
// own promise chain started outside any request.
export function bindUsageScope<T>(fn: () => Promise<T>, extra: UsageScope = {}): () => Promise<T> {
  const scope = { ...currentUsageScope(), ...withoutBlanks(extra) };
  return () => storage.run(scope, fn);
}

function withoutBlanks(scope: UsageScope): UsageScope {
  const kept: UsageScope = {};
  if (scope.campaignId) {
    kept.campaignId = scope.campaignId;
  }
  if (scope.userId) {
    kept.userId = scope.userId;
  }
  return kept;
}

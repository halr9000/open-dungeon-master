// Per-campaign job serializer: at most one DM narration runs per campaign at
// a time, and jobs run in arrival order. Lives on globalThis so dev-mode HMR
// cannot fork the queue. llama-server runs with --parallel 1, so global
// concurrency stays low naturally (jobs from different campaigns queue at the
// model server).

import { bindUsageScope } from "@/lib/usage/scope";

type Pause = { reason: string; promise: Promise<void>; resolve: () => void };

declare global {
  var __odmDmQueues: Map<string, Promise<void>> | undefined;
  var __odmDmPauses: Map<string, Pause> | undefined;
  var __odmDmDropped: Set<string> | undefined;
  var __odmDmDepths: Map<string, number> | undefined;
}

function queues() {
  return (globalThis.__odmDmQueues ??= new Map<string, Promise<void>>());
}

function pauses() {
  return (globalThis.__odmDmPauses ??= new Map<string, Pause>());
}

// A paused campaign (docs/vtt-parity-implementation-plan.md 9.1, the
// X-card) keeps its queue but runs nothing: every job waits at the gate
// until someone resumes it. Pausing twice keeps the first reason.
export function pauseDmQueue(campaignId: string, reason: string): void {
  if (pauses().has(campaignId)) {
    return;
  }
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  pauses().set(campaignId, { reason, promise, resolve });
}

export function resumeDmQueue(campaignId: string): boolean {
  const pause = pauses().get(campaignId);
  if (!pause) {
    return false;
  }
  pauses().delete(campaignId);
  pause.resolve();
  return true;
}

export function dmQueuePaused(campaignId: string): string | null {
  return pauses().get(campaignId)?.reason ?? null;
}

function gate(campaignId: string): Promise<void> {
  const pause = pauses().get(campaignId);
  return pause ? pause.promise.then(() => gate(campaignId)) : Promise.resolve();
}

// Campaigns deleted while jobs were still waiting: those jobs are skipped
// rather than run against rows that are gone.
function dropped() {
  return (globalThis.__odmDmDropped ??= new Set<string>());
}

function depths() {
  return (globalThis.__odmDmDepths ??= new Map<string, number>());
}

// How many jobs a campaign has queued or running.
export function dmQueueDepth(campaignId: string): number {
  return depths().get(campaignId) ?? 0;
}

// Across every campaign: how many have work queued and how many jobs that is.
export function dmQueueTotals(): { campaigns: number; jobs: number } {
  let jobs = 0;
  for (const depth of depths().values()) jobs += depth;
  return { campaigns: depths().size, jobs };
}

export function enqueueDmJob(campaignId: string, job: () => Promise<void>) {
  const tail = queues().get(campaignId) ?? Promise.resolve();
  // The job runs later, off the request that queued it; it still answers
  // to this campaign in the usage ledger (src/lib/usage/scope.ts).
  const scoped = bindUsageScope(job, { campaignId });
  depths().set(campaignId, dmQueueDepth(campaignId) + 1);
  const next = tail
    .then(() => gate(campaignId))
    .then(() => (dropped().has(campaignId) ? undefined : scoped()))
    .catch((error) => {
      console.error(`[dm] job failed for campaign ${campaignId}:`, error);
    })
    .finally(() => {
      const left = dmQueueDepth(campaignId) - 1;
      if (left > 0) {
        depths().set(campaignId, left);
      } else {
        depths().delete(campaignId);
      }
      // The last job out takes the campaign's entry with it, so the map does
      // not keep a settled promise for every table that ever had a turn.
      if (queues().get(campaignId) === next) {
        queues().delete(campaignId);
        dropped().delete(campaignId);
      }
    });
  queues().set(campaignId, next);
  return next;
}

// A deleted campaign: whatever is still waiting is skipped, a pause (which
// would hold those jobs forever) is lifted, and the entries go once the
// queue runs dry.
export function dropDmQueue(campaignId: string): void {
  if (queues().has(campaignId)) {
    dropped().add(campaignId);
  }
  resumeDmQueue(campaignId);
}

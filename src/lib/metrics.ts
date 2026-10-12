import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { dmQueueTotals } from "@/lib/dm/queue";
import { openStreamCount } from "@/lib/live-streams";
import { mediaQueueStats } from "@/lib/media-queue";

// What the server process is doing, for an admin judging whether it keeps
// up (audit P15): how late the event loop runs, memory, open live streams,
// and how deep the DM and media queues are and how long their last jobs
// waited. Counts and timings only: nothing about a campaign's content or a
// player is kept. The loop histogram costs one timer at 20 ms resolution.

declare global {
  var __odmLoopDelay: { histogram: IntervalHistogram; since: number } | undefined;
}

const RESOLUTION_MS = 20;

export function startProcessMetrics(): void {
  if (globalThis.__odmLoopDelay) return;
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  globalThis.__odmLoopDelay = { histogram, since: Date.now() };
}

// The histogram records each whole sampling interval; the lag is what runs
// past the interval itself.
const lagMs = (ns: number): number => Math.max(0, Math.round(ns / 1e5 - RESOLUTION_MS * 10) / 10);
const mb = (bytes: number): number => Math.round(bytes / 1024 / 102.4) / 10;

export interface ProcessMetrics {
  uptimeSeconds: number;
  // Since the previous read (or the start): each read begins a new window.
  eventLoopDelayMs: { windowSeconds: number; p50: number; p95: number; p99: number; max: number } | null;
  memoryMb: { rss: number; heapUsed: number; heapTotal: number; external: number };
  openStreams: number;
  dmQueue: { campaigns: number; jobs: number };
  mediaQueues: ReturnType<typeof mediaQueueStats>;
}

export function processMetrics(): ProcessMetrics {
  const loop = globalThis.__odmLoopDelay;
  let eventLoopDelayMs: ProcessMetrics["eventLoopDelayMs"] = null;
  if (loop && loop.histogram.count > 0) {
    const { histogram } = loop;
    eventLoopDelayMs = {
      windowSeconds: Math.round((Date.now() - loop.since) / 1000),
      p50: lagMs(histogram.percentile(50)),
      p95: lagMs(histogram.percentile(95)),
      p99: lagMs(histogram.percentile(99)),
      max: lagMs(histogram.max),
    };
    histogram.reset();
    loop.since = Date.now();
  }
  const memory = process.memoryUsage();
  return {
    uptimeSeconds: Math.round(process.uptime()),
    eventLoopDelayMs,
    memoryMb: { rss: mb(memory.rss), heapUsed: mb(memory.heapUsed), heapTotal: mb(memory.heapTotal), external: mb(memory.external) },
    openStreams: openStreamCount(),
    dmQueue: dmQueueTotals(),
    mediaQueues: mediaQueueStats(),
  };
}

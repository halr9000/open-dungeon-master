import { currentSessionTokenHash } from "@/lib/auth";
import { isErrorResponse, requireMember } from "@/lib/campaign-api";
import { isCampaignMember, latestSeq } from "@/lib/db/campaigns";
import { sessionHolder } from "@/lib/db/users";
import { chunkSeq, planReplay, replayEventsSince, sseChunk, subscribe } from "@/lib/events";
import { streamCapacityLeft, trackStream } from "@/lib/live-streams";
import { STREAM_PING_MS } from "@/app/campaigns/[campaignId]/streamWatchdog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Bytes a reader may leave unread before the stream gives up on it. A tab
// that stopped reading (a frozen phone, a stalled tunnel) would otherwise
// have every event of the session queued for it in this process; closed, it
// reconnects and reloads its snapshot like any dropped stream.
const SLOW_READER_BYTES = 4 * 1024 * 1024;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  const { campaignId } = await params;
  const context = await requireMember(campaignId);
  if (isErrorResponse(context)) {
    return context;
  }
  if (!streamCapacityLeft()) {
    return Response.json(
      { error: "The server is holding too many live connections. Retrying shortly." },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
  const userId = context.user.id;
  const tokenHash = await currentSessionTokenHash();

  // Catch-up point: EventSource sends Last-Event-ID on auto-reconnect; the
  // first connect passes ?lastSeq= from the snapshot fetch. A cursor too far
  // behind (or not a cursor at all) is not replayed: the page is told to
  // reload its snapshot instead (planReplay, src/lib/events.ts).
  const url = new URL(request.url);
  const plan = planReplay(
    request.headers.get("last-event-id") ?? url.searchParams.get("lastSeq"),
    latestSeq(campaignId),
  );

  // Still this member's seat on this session? Asked on every beat, so a
  // session that expired or a seat that went away without passing the
  // places that close streams at once (src/lib/live-streams.ts) still ends
  // within one beat. A read that fails keeps the stream: a database hiccup
  // must not drop every table at once.
  const stillAllowed = () => {
    try {
      return !!tokenHash && sessionHolder(tokenHash) === userId && isCampaignMember(campaignId, userId);
    } catch {
      return true;
    }
  };

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        // Live events published while the replay is still reading are held
        // and sent after it, in order, so the page never sees a live event
        // ahead of the history it follows.
        let replaying = true;
        const held: string[] = [];

        const write = (chunk: string) => {
          if (closed) {
            return;
          }
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            cleanup();
            return;
          }
          if ((controller.desiredSize ?? 0) < -SLOW_READER_BYTES) {
            console.warn(`[events] closing a stream of ${campaignId} whose reader stopped reading`);
            cleanup();
          }
        };
        const send = (chunk: string) => {
          if (closed) {
            return;
          }
          if (replaying) {
            held.push(chunk);
            return;
          }
          write(chunk);
        };

        // The member's id rides along so the bus can keep the campaign's
        // online set and announce joins and leaves (presence ephemeral).
        const unsubscribe = subscribe(campaignId, send, userId);
        const untrack = trackStream({ tokenHash, userId, campaignId, close: () => cleanup() });

        // Assigned once the first beat is out; cleanup may run before that.
        let heartbeat: ReturnType<typeof setInterval> | undefined = undefined;
        cleanup = () => {
          if (closed) {
            return;
          }
          closed = true;
          held.length = 0;
          clearInterval(heartbeat);
          unsubscribe();
          untrack();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        // A named event rather than an SSE comment: a page never sees a
        // comment, and the beat is how it tells a quiet table from a stream
        // that died without closing (streamWatchdog.ts, issue 73). No id, so
        // a reconnect never resumes from a beat.
        // One beat at once, so a stream that dies in its first seconds is
        // still noticed.
        write(sseChunk("ping", {}));
        heartbeat = setInterval(() => {
          if (!stillAllowed()) {
            cleanup();
            return;
          }
          write(sseChunk("ping", {}));
        }, STREAM_PING_MS);

        // Replay every persisted event missed while disconnected, batch after
        // batch until none are left, then go live. Stopping at one batch left
        // a gap after a long absence that the client's seq guard (which only
        // rejects duplicates) could not see.
        // Replayed as this member may read it: the notes on their own sheet,
        // and no roll that was made for another seat.
        const catchUp = async () => {
          let reached = 0;
          if (plan.kind === "resync") {
            // No id: the page reloads its snapshot and keeps its own cursor.
            write(sseChunk("resync", { latestSeq: plan.latest }));
            reached = plan.latest;
          } else {
            ({ reached } = await replayEventsSince(campaignId, plan.from, {
              each: (event) => write(sseChunk(event.type, event.payload, event.seq)),
              stopped: () => closed,
              viewerUserId: userId,
            }));
          }
          replaying = false;
          for (const chunk of held.splice(0)) {
            const seq = chunkSeq(chunk);
            // Already sent by the replay (it was persisted while being read).
            if (seq !== null && seq <= reached) {
              continue;
            }
            write(chunk);
          }
        };
        catchUp().catch((error) => {
          console.error(`[events] replay for ${campaignId} failed`, error);
          cleanup();
        });

        request.signal.addEventListener("abort", () => cleanup());
      },
      cancel() {
        cleanup();
      },
    },
    { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

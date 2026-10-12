import { currentSessionTokenHash, currentUser } from "@/lib/auth";
import { sessionHolder } from "@/lib/db/users";
import { streamCapacityLeft, trackStream } from "@/lib/live-streams";
import { subscribeUser } from "@/lib/user-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 20_000;

// The bell's live channel: a contentless "notice" ping whenever this user's
// inbox changes (src/lib/user-events.ts). Same response shape as the
// campaign events route, but with no replay: the bell's poll is the
// catch-up path, so a missed ping costs a minute of latency, not data.
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }
  if (!streamCapacityLeft()) {
    return Response.json({ error: "Too many live connections." }, { status: 503, headers: { "Retry-After": "30" } });
  }
  const tokenHash = await currentSessionTokenHash();

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      const unsubscribe = subscribeUser(user.id, send);
      // Ended at once by signing out or a password change, and checked on
      // every beat for a session that simply ran out (src/lib/live-streams.ts).
      const untrack = trackStream({ tokenHash, userId: user.id, campaignId: null, close: () => cleanup() });
      const heartbeat = setInterval(() => {
        let allowed = true;
        try {
          allowed = !!tokenHash && sessionHolder(tokenHash) === user.id;
        } catch {
          // A failed read keeps the stream; the next beat asks again.
        }
        if (!allowed) {
          cleanup();
          return;
        }
        send(": ping\n\n");
      }, HEARTBEAT_MS);

      cleanup = () => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        untrack();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      request.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

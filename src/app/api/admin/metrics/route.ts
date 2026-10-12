import { isErrorResponse, requireAdmin } from "@/lib/admin-api";
import { processMetrics } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The server process's load for an admin (src/lib/metrics.ts): event loop
// delay, memory, open streams, queue depths and waits. Counts only.
export async function GET() {
  const admin = await requireAdmin();
  if (isErrorResponse(admin)) {
    return admin;
  }
  return Response.json(processMetrics(), { headers: { "cache-control": "no-store" } });
}

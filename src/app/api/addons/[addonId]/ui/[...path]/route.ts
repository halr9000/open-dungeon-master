import path from "node:path";
import { findInstalledAddon } from "@/lib/addons/installed";
import { serveAddonFile } from "@/lib/addons/static-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/addons/<id>/ui/<file>: an addon's own web files, the pages its
// board views draw in (src/lib/addons/board-bridge.ts). Served to anyone who
// asks, with the headers src/lib/addons/static-files.ts explains. Only
// switched-on addons are served; anything else is a 404.

const MAX_UI_FILE_BYTES = 64 * 1024 * 1024;

export async function GET(_request: Request, { params }: { params: Promise<{ addonId: string; path: string[] }> }) {
  const { addonId, path: segments } = await params;
  const addon = findInstalledAddon(addonId);
  if (!addon || addon.status !== "ready") return Response.json({ error: "Not found." }, { status: 404 });
  return serveAddonFile(path.join(addon.dir, "ui"), segments, MAX_UI_FILE_BYTES);
}

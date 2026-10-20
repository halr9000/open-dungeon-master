import path from "node:path";
import { findInstalledAddon } from "@/lib/addons/installed";
import { addonDataDir } from "@/lib/addons/paths";
import { serveAddonFile } from "@/lib/addons/static-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/addons/<id>/assets/<file>: an addon's asset library, the files
// its setup (or its tools) wrote to the public/ folder of its data folder:
// models, sprite sheets and textures its board view loads by name, as
// "../assets/<file>" from its own page. Served to anyone who asks, with the
// headers src/lib/addons/static-files.ts explains, so nothing private
// belongs there. Only switched-on addons are served; anything else is a 404.

const MAX_ASSET_BYTES = 512 * 1024 * 1024;

export async function GET(_request: Request, { params }: { params: Promise<{ addonId: string; path: string[] }> }) {
  const { addonId, path: segments } = await params;
  const addon = findInstalledAddon(addonId);
  const dataDir = addon ? addonDataDir(addon.id) : null;
  if (!addon || addon.status !== "ready" || !dataDir) return Response.json({ error: "Not found." }, { status: 404 });
  return serveAddonFile(path.join(dataDir, "public"), segments, MAX_ASSET_BYTES);
}

import { isErrorResponse, requireAdmin } from "@/lib/admin-api";
import { installedResponse } from "@/lib/addons/admin-view";
import { installAddonArchive } from "@/lib/addons/install";
import { readAddonConfig } from "@/lib/addons/store";
import { addonSupport } from "@/lib/addons/support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/addons/upload: an addon .zip the admin picked, as the raw
// request body. For trying an addon before it is in the catalog, or running
// one of your own. Off until the admin switches on "Install addons from
// files and links", because nobody has reviewed what arrives this way.

const MAX_SIDELOAD_BYTES = 64 * 1024 * 1024;

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (isErrorResponse(admin)) {
    return admin;
  }
  const support = addonSupport();
  if (!support.supported) {
    return Response.json({ error: support.reason }, { status: 400 });
  }
  if (!readAddonConfig().allowFiles) {
    return Response.json({ error: "Installing addons from files is switched off. Switch on \"Install addons from files and links\" under Addons first." }, { status: 403 });
  }
  // The declared size first, with "at the cap" counted as over it: the
  // proxy hands a route at most what it copied, so a body that reached the
  // ceiling may have been cut there.
  const declared = Number(request.headers.get("content-length") ?? "");
  if (!Number.isFinite(declared) || declared <= 0) {
    return Response.json({ error: "Send the archive with its size." }, { status: 411 });
  }
  if (declared >= MAX_SIDELOAD_BYTES) {
    return Response.json({ error: "An addon archive installed from a file may be up to 64 MB." }, { status: 413 });
  }
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length !== declared) {
    return Response.json({ error: "The archive did not arrive whole. Try again." }, { status: 400 });
  }
  // ?replace=1 once the admin agreed to replace a copy from somewhere else.
  const replace = new URL(request.url).searchParams.get("replace") === "1";
  return installedResponse(await installAddonArchive(bytes, "file", undefined, { replace }), admin);
}

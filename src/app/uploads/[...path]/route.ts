import { currentUser, unauthorized } from "@/lib/auth";
import { variantWidth } from "@/lib/image-format";
import { servedSegments } from "@/lib/image-variants";
import { mayReadMedia } from "@/lib/media-access";
import { serveGeneratedFile } from "@/lib/serve-file";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serves runtime-uploaded images (avatars and portraits); public/uploads is
// not covered by build-time static serving, so files uploaded while the
// server runs would 404 until a restart without this route. These are
// player uploads, not a public gallery: only the members of a place that
// holds the file may open it (src/lib/media-access.ts).
//
// ?w=256 or ?w=1024 asks for the smaller WebP copy written beside the
// original (src/lib/image-variants.ts); when there is none, the original
// goes out under the same headers.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const user = await currentUser();
  if (!user) {
    return unauthorized();
  }
  const { path: segments } = await params;
  // Only for the places that hold it (src/lib/media-access.ts); anyone else
  // hears what a missing file would say.
  if (!mayReadMedia(user, `/uploads/${segments.join("/")}`)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const width = variantWidth(new URL(request.url).searchParams.get("w"));
  const served = width ? await servedSegments("uploads", segments, width) : segments;
  return serveGeneratedFile("uploads", served, request);
}

import { currentUser, unauthorized } from "@/lib/auth";
import { appendChunk, UPLOAD_CHUNK_BYTES, uploadFor } from "@/lib/addons/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUT /api/addons/uploads/<id>?offset=N: one piece of an upload, as the raw
// body, written at the offset it names (which must be where the last one
// ended). Answers how many bytes have arrived.

export async function PUT(request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const { uploadId } = await params;
  const upload = uploadFor(uploadId, user.id);
  if (!upload) return Response.json({ error: "That upload is not open." }, { status: 404 });
  const offset = Number(new URL(request.url).searchParams.get("offset"));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return Response.json({ error: "Name the offset this piece starts at." }, { status: 400 });
  }
  const declared = Number(request.headers.get("content-length") ?? "");
  if (!Number.isFinite(declared) || declared <= 0 || declared > UPLOAD_CHUNK_BYTES) {
    return Response.json({ error: `Send pieces of up to ${UPLOAD_CHUNK_BYTES} bytes, with their size.` }, { status: 413 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length !== declared) {
    return Response.json({ error: "That piece did not arrive whole." }, { status: 400 });
  }
  const result = await appendChunk(upload, offset, bytes);
  if (!result.ok) return Response.json({ error: result.error, received: upload.received }, { status: result.status });
  return Response.json({ received: result.received, size: upload.size });
}

"use client";

// Sends a file for an addon to read, in the pieces /api/addons/uploads takes
// (src/lib/addons/uploads.ts says why), reporting how much has gone. A piece
// that fails is tried again twice; a 409 says where the server really is (an
// answer lost after the piece landed), and the upload carries on from there.

export async function uploadForAddon(
  file: File,
  onProgress: (sent: number) => void,
): Promise<{ ok: true; uploadId: string } | { ok: false; error: string }> {
  const opened = await fetch("/api/addons/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, mime: file.type, size: file.size }),
  }).catch(() => null);
  const start = opened ? await opened.json().catch(() => ({})) : {};
  if (!opened?.ok) return { ok: false, error: start.error ?? "Could not start the upload." };
  const { uploadId, chunkBytes } = start as { uploadId: string; chunkBytes: number };
  let offset = 0;
  while (offset < file.size) {
    const piece = file.slice(offset, offset + chunkBytes);
    let next = -1;
    let lastError = "The file did not finish sending.";
    for (let attempt = 0; attempt < 3 && next < 0; attempt += 1) {
      const sent = await fetch(`/api/addons/uploads/${uploadId}?offset=${offset}`, { method: "PUT", body: piece }).catch(() => null);
      if (sent?.ok) {
        next = offset + piece.size;
        break;
      }
      const data = sent ? await sent.json().catch(() => ({})) : {};
      if (sent?.status === 409 && typeof data.received === "number" && data.received > offset) {
        next = data.received;
        break;
      }
      if (data.error) lastError = data.error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (next < 0) return { ok: false, error: lastError };
    offset = next;
    onProgress(offset);
  }
  return { ok: true, uploadId };
}

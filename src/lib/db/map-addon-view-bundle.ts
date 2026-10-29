import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_VIEW_FILE_BYTES } from "@/lib/addons/contracts";
import { normalizeMapAddonView, parseMapAddonView, type MapAddonView } from "@/lib/addons/map-view";
import { sniffImage } from "@/lib/addons/sniff";
import { recordMediaFile } from "@/lib/media-access";
import type { WorkshopBundle } from "@/lib/workshop/bundle";

// A map's addon view inside a workshop bundle: on export the files it names
// go in as data URLs, sharing the bundle's image budget; on import each file
// is decoded, held to the type its bytes say it is (a binary glTF or a
// picture), written under a fresh name in public/uploads, and the view is
// stored with the new map. Split from the bundle modules, which are at
// their size.

type BundleAddonView = NonNullable<WorkshopBundle["maps"][number]["addonView"]>;
type Budget = { remaining: number; skipped: number };

const DATA_URL = /^data:(model\/gltf-binary|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/=]+)$/;

function mimeFor(relPath: string): string {
  const extension = relPath.split(".").pop()?.toLowerCase();
  if (extension === "glb") return "model/gltf-binary";
  return extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
}

export function exportMapAddonView(json: unknown, budget: Budget): BundleAddonView | null {
  const view = parseMapAddonView(typeof json === "string" ? json : "");
  if (!view) return null;
  const files: BundleAddonView["files"] = [];
  for (const file of view.files) {
    let encoded = "";
    try {
      const bytes = readFileSync(path.join(/*turbopackIgnore: true*/ process.cwd(), "public", file.path));
      encoded = `data:${mimeFor(file.path)};base64,${bytes.toString("base64")}`;
    } catch {
      // A file that is gone stays behind, counted below.
    }
    if (!encoded || encoded.length > budget.remaining) {
      budget.skipped += 1;
      continue;
    }
    budget.remaining -= encoded.length;
    files.push({ name: file.name, type: file.type, data: encoded });
  }
  return { addonId: view.addonId, data: view.data, files };
}

export type DecodedAddonView = {
  addonId: string;
  data: unknown;
  files: Array<{ name: string; type: string; ext: "glb" | "png" | "jpg" | "webp"; bytes: Buffer }>;
};

// Decoded before anything is written, so the import can weigh the files
// against the importer's upload budget with the rest of its art.
export function decodeBundleAddonView(view: BundleAddonView | null): DecodedAddonView | null {
  if (!view) return null;
  const files: DecodedAddonView["files"] = [];
  for (const file of view.files) {
    const match = DATA_URL.exec(file.data);
    if (!match) continue;
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.length > MAX_VIEW_FILE_BYTES) continue;
    if (match[1] === "model/gltf-binary") {
      if (bytes.subarray(0, 4).toString("latin1") !== "glTF") continue;
      files.push({ name: file.name, type: "model/gltf-binary", ext: "glb", bytes });
      continue;
    }
    const sniffed = sniffImage(bytes);
    if (!sniffed) continue;
    files.push({ name: file.name, type: sniffed, ext: sniffed === "image/png" ? "png" : sniffed === "image/webp" ? "webp" : "jpg", bytes });
  }
  return { addonId: view.addonId, data: view.data ?? null, files };
}

export function landAddonView(view: DecodedAddonView | null, uploadDir: string, written: string[]): MapAddonView | null {
  if (!view) return null;
  const files = view.files.map((file) => {
    const name = `${crypto.randomUUID()}.${file.ext}`;
    writeFileSync(path.join(/*turbopackIgnore: true*/ uploadDir, name), file.bytes);
    const url = `/uploads/${name}`;
    recordMediaFile(url);
    written.push(url);
    return { name: file.name, path: url, type: file.type, bytes: file.bytes.length };
  });
  return normalizeMapAddonView({ addonId: view.addonId, data: view.data, files });
}

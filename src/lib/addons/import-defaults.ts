import path from "node:path";
import { WORKSHOP_BUNDLE_KIND, WORKSHOP_BUNDLE_VERSION } from "@/lib/workshop/bundle-schema";

// Pure, so the core suite (scripts/test-addons-core.mjs) checks it without
// starting anything.

// The manifest fields a bundle must carry, filled in where the addon left
// them out: what the preview names the workshop, and where it came from.
export function withManifestDefaults(raw: unknown, fileName: string, addonName: string): Record<string, unknown> {
  const bundle = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};
  const title = path.basename(fileName, path.extname(fileName)).replace(/[_-]+/g, " ").trim().slice(0, 70) || "Imported workshop";
  const manifest = bundle.manifest && typeof bundle.manifest === "object" ? { ...(bundle.manifest as Record<string, unknown>) } : {};
  const blank = (value: unknown) => typeof value !== "string" || !value.trim();
  if (blank(manifest.name)) manifest.name = title;
  if (blank(manifest.blurb)) manifest.blurb = `Read from ${fileName.slice(0, 120)} by ${addonName}.`.slice(0, 200);
  if (blank(manifest.inspiredBy)) manifest.inspiredBy = fileName.slice(0, 200);
  bundle.kind ??= WORKSHOP_BUNDLE_KIND;
  bundle.version ??= WORKSHOP_BUNDLE_VERSION;
  bundle.manifest = manifest;
  return bundle;
}

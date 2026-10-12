import type { MaskedConfig } from "@/app/admin/AdminSettingsFields";

export type AdminConfigDraftPatch = {
  harness?: Partial<MaskedConfig["harness"]>;
  text?: Partial<MaskedConfig["text"]>;
  images?: Partial<MaskedConfig["images"]>;
};

// Independent admin sections save only their own fields. Merge at both the
// top level and within nested settings so in-progress drafts survive.
export function mergeAdminConfigDraft(
  current: MaskedConfig,
  patch: AdminConfigDraftPatch,
): MaskedConfig {
  return {
    ...current,
    ...(patch.harness ? { harness: { ...current.harness, ...patch.harness } } : {}),
    ...(patch.text ? { text: { ...current.text, ...patch.text } } : {}),
    ...(patch.images ? { images: { ...current.images, ...patch.images } } : {}),
  };
}

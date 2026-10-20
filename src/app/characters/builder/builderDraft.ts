// An unfinished new character, kept on this device so a closed tab, a phone
// call or an Escape on the companion dialog costs nothing: the builder offers
// it back the next time it opens at the same door. Only new characters are
// kept; an edit of a stored one loses nothing by leaving. One draft per
// door, cleared when the character is saved. localStorage can be missing or
// full (a private window, an app shell that blocks it), so every call
// swallows its errors and the builder works without it.
import type { BuilderDraftFields } from "./useBuilderState";

const PREFIX = "odm:builder-draft:";
const VERSION = 1;
// A draft this old is from another evening's plans, not this one's.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type BuilderDraft = { v: typeof VERSION; savedAt: number; step: number; fields: BuilderDraftFields };

// The door a draft belongs to: the library's new character, a table's join
// page, or a table's companion dialog.
export function builderDraftKey(door: "library" | "table" | "companion", campaignId?: string): string {
  return door === "library" ? "library" : `${door}:${campaignId ?? ""}`;
}

export function readBuilderDraft(key: string): BuilderDraft | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) {
      return null;
    }
    const draft = JSON.parse(raw) as BuilderDraft;
    if (draft?.v !== VERSION || !draft.fields || Date.now() - draft.savedAt > MAX_AGE_MS) {
      window.localStorage.removeItem(PREFIX + key);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

export function writeBuilderDraft(key: string, step: number, fields: BuilderDraftFields) {
  try {
    const draft: BuilderDraft = { v: VERSION, savedAt: Date.now(), step, fields };
    window.localStorage.setItem(PREFIX + key, JSON.stringify(draft));
  } catch {
    // Nothing kept; the builder still works.
  }
}

export function clearBuilderDraft(key: string) {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    // Nothing to clear.
  }
}

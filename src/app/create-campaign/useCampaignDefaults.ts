"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CAMPAIGN_DEFAULTS_VERSION, type CampaignDefaults, type CampaignDefaultSettings } from "@/lib/campaign-defaults";

// The signed-in person's saved campaign defaults, read when the dialog opens
// and written only when they press save or remove. A failure is reported and
// changes nothing else: the dialog keeps working on the app's defaults.
export type DefaultsState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "saved"; defaults: CampaignDefaults }
  | { status: "unavailable"; error: string };

type Outcome = { ok: true } | { ok: false; error: string };

async function reason(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof data?.error === "string" && data.error ? data.error : fallback;
}

// `onLoaded` hears what was found each time the dialog opens (null for
// nothing saved or nothing readable), from the fetch's own callback, so the
// dialog can start a fresh draft from it.
export function useCampaignDefaults(open: boolean, onLoaded: (defaults: CampaignDefaults | null) => void) {
  const [state, setState] = useState<DefaultsState>({ status: "loading" });
  const loaded = useRef(onLoaded);
  useEffect(() => {
    loaded.current = onLoaded;
  }, [onLoaded]);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    fetch("/api/profile/campaign-defaults", { cache: "no-store" })
      .then(async (response) => {
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          setState({ status: "unavailable", error: await reason(response, "Your saved defaults could not be read.") });
          return;
        }
        const data = (await response.json().catch(() => null)) as { defaults?: CampaignDefaults | null } | null;
        if (!cancelled) {
          setState(data?.defaults ? { status: "saved", defaults: data.defaults } : { status: "none" });
          loaded.current(data?.defaults ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "unavailable", error: "Your saved defaults could not be reached." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const save = useCallback(async (settings: CampaignDefaultSettings): Promise<Outcome> => {
    try {
      const response = await fetch("/api/profile/campaign-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: CAMPAIGN_DEFAULTS_VERSION, settings }),
      });
      if (!response.ok) {
        return { ok: false, error: await reason(response, "Your defaults were not saved.") };
      }
      const data = (await response.json().catch(() => null)) as { defaults?: CampaignDefaults } | null;
      if (data?.defaults) {
        setState({ status: "saved", defaults: data.defaults });
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "Could not reach the server; your defaults were not saved." };
    }
  }, []);

  const remove = useCallback(async (): Promise<Outcome> => {
    try {
      const response = await fetch("/api/profile/campaign-defaults", { method: "DELETE" });
      if (!response.ok) {
        return { ok: false, error: await reason(response, "Your defaults were not removed.") };
      }
      setState({ status: "none" });
      return { ok: true };
    } catch {
      return { ok: false, error: "Could not reach the server; your defaults were not removed." };
    }
  }, []);

  return { state, save, remove };
}

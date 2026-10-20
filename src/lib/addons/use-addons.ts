"use client";

import { useEffect, useState } from "react";
import type { OfferedContributions } from "@/lib/addons/offered";
import { shellHost } from "@/lib/shell-host";

// What the server's switched-on addons offer, for the pages that show their
// controls: the workshop's "Import with an addon", the map library's
// generators, the board's view switch. Fetched once per page load and shared
// by every caller; an admin who switches an addon on sees it after a reload.
//
// The Android app does not offer addons yet: on the phone this answers
// nothing, so no addon control is drawn there. What addons made (a workshop,
// a map and its picture) is ordinary content and shows everywhere.

const NONE: OfferedContributions = { supported: false, workshopImporters: [], mapGenerators: [], boardViews: [] };

let cached: OfferedContributions | null = null;
let pending: Promise<OfferedContributions> | null = null;

function load(): Promise<OfferedContributions> {
  if (cached) return Promise.resolve(cached);
  pending ??= fetch("/api/addons")
    .then((response) => (response.ok ? (response.json() as Promise<OfferedContributions>) : NONE))
    .catch(() => NONE)
    .then((value) => {
      cached = value;
      pending = null;
      return value;
    });
  return pending;
}

export function addonsOfferedHere(): boolean {
  return shellHost()?.platform !== "android";
}

export function useAddons(): OfferedContributions {
  const [value, setValue] = useState<OfferedContributions>(cached ?? NONE);
  useEffect(() => {
    if (!addonsOfferedHere()) return;
    let live = true;
    void load().then((next) => {
      if (live) setValue(next);
    });
    return () => {
      live = false;
    };
  }, []);
  return addonsOfferedHere() ? value : NONE;
}

// After an admin changes addons, so the next page reads them afresh.
export function forgetAddons() {
  cached = null;
}

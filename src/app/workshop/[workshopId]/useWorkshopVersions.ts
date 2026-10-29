"use client";

import { useEffect, useRef, useState } from "react";
import { RECORD_KINDS, type RecordKind } from "@/lib/workshop/record-events-kinds";

// The workshop listening for changes to its records (audit finding WF-21),
// on the campaign event stream every table page already uses: a workshop is
// a campaigns row. Each kind of record has a version, bumped when it
// changes here or in another tab, and each tool refetches when its own
// kind's version moves. Refetching replaces a tool's list, never the draft
// in an open editor.
//
// The workshop keeps no snapshot to resume from, so it asks to start live:
// a cursor that is no cursor makes the stream skip its history
// (src/lib/events.ts planReplay). A reconnect refetches everything once,
// and from then on only what changed.

export type RecordVersions = Record<RecordKind, number>;

const ZERO = Object.fromEntries(RECORD_KINDS.map((kind) => [kind, 0])) as RecordVersions;

// The table's own events, which the workshop's records also change by.
const TABLE_EVENTS: Record<string, RecordKind[]> = {
  world_updated: ["world"],
  factions_updated: ["faction", "world"],
  lore_updated: ["lore", "world"],
  npc_updated: ["npc", "world"],
  location_updated: ["location", "world"],
};

// Bursts (a save's own echo, an import's several events) are gathered for
// a moment and applied as one bump per kind.
const GATHER_MS = 250;

export function useWorkshopVersions(workshopId: string): RecordVersions {
  const [versions, setVersions] = useState<RecordVersions>(ZERO);
  const waiting = useRef(new Set<RecordKind>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const gathered = waiting.current;
    const bump = (kinds: readonly RecordKind[]) => {
      for (const kind of kinds) if ((RECORD_KINDS as readonly string[]).includes(kind)) gathered.add(kind);
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        const changed = [...gathered];
        gathered.clear();
        setVersions((current) => {
          const next = { ...current };
          for (const kind of changed) next[kind] += 1;
          return next;
        });
      }, GATHER_MS);
    };
    const source = new EventSource(`/api/campaigns/${workshopId}/events?lastSeq=live`);
    // Each tool loaded itself on mount, so the first open changes nothing;
    // a reopen after a drop may have missed changes, so everything is
    // refetched once. The stream's "resync" always follows an open.
    let opened = false;
    source.addEventListener("open", () => {
      if (opened) bump(RECORD_KINDS);
      opened = true;
    });
    source.addEventListener("records_changed", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { kinds?: unknown };
        if (Array.isArray(payload.kinds)) bump(payload.kinds.filter((kind): kind is RecordKind => typeof kind === "string") as RecordKind[]);
      } catch {
        // A ping that cannot be read changes nothing.
      }
    });
    for (const [type, kinds] of Object.entries(TABLE_EVENTS)) source.addEventListener(type, () => bump(kinds));
    return () => {
      source.close();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      gathered.clear();
    };
  }, [workshopId]);

  return versions;
}

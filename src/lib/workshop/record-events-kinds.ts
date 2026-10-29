// The kinds of record whose changes the workshop's tools listen for
// (src/lib/workshop/record-events.ts publishes them). Apart from that file
// so the browser can read the list without the server's event bus.
export const RECORD_KINDS = ["npc", "lore", "location", "faction", "world"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

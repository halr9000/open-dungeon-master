// Every walkthrough that opens by itself the first time (issue #306): the
// two table tours, the Hand's card tutorial, and the workshop's shelf, hub
// and tool tours. The account records which of these a person finished and
// at which version; the route records no other id. No "@/" imports here:
// scripts/test-tours.mjs loads it straight from disk.
import { DM_TOUR_ID, PLAYER_TOUR_ID } from "./table.ts";
import { HUB_TOUR_ID, SHELF_TOUR_ID, SYSTEM_TOURS, systemTourId } from "./workshop.ts";

// The first fight's two-row card (HandTutorial.tsx). Kept here rather than
// in the component so the route can name it without importing client code.
export const HAND_TUTORIAL_ID = "battle-hand-intro";

export const TOUR_IDS: readonly string[] = [
  PLAYER_TOUR_ID,
  DM_TOUR_ID,
  HAND_TUTORIAL_ID,
  SHELF_TOUR_ID,
  HUB_TOUR_ID,
  ...Object.keys(SYSTEM_TOURS).map(systemTourId),
];

// Every tour starts at version 1. Raise a tour's number here when it changes
// enough that people who finished it should be walked through it again: an
// account holding a lower version sees it once more, and finishing it records
// the new one. Nothing else re-opens a finished tour; Help replays any of
// them by hand.
const REVISED: Readonly<Record<string, number>> = {};

export function tourVersion(tourId: string): number {
  return REVISED[tourId] ?? 1;
}

export function isTourId(value: unknown): value is string {
  return typeof value === "string" && TOUR_IDS.includes(value);
}

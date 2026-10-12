// How long the table's text boxes may run, in one place, so a box can say
// its limit before anything is sent and the route refuses with the same
// number (issue 207). A box that only learned its limit from a bare
// "Invalid action." after the send, or quietly lost the end of a private
// direction, gave the player no way to know what went wrong.
//
// Pure: the routes and the composer both read it.
import { MAX_ABSOLUTE_COMMAND_LENGTH } from "@/lib/dm/director-logic";
import type { InputKind } from "@/lib/campaign-types";

// A move, a line spoken, or table talk (actions/route.ts).
export const ACTION_MAX_CHARS = 2_000;
// A passage the DM in the seat writes (dm/narrate/route.ts).
export const NARRATION_MAX_CHARS = 8_000;
// A direction the table reads (lead-note/route.ts).
export const LEAD_NOTE_MAX_CHARS = 1_000;

// What the composer's box may hold in this mode. A private direction is the
// director's one-turn steer, kept short on purpose (director-logic.ts).
export function composerLimit(kind: InputKind, leadPrivate: boolean): number {
  if (kind === "narrate") return NARRATION_MAX_CHARS;
  if (kind === "lead") return leadPrivate ? MAX_ABSOLUTE_COMMAND_LENGTH : LEAD_NOTE_MAX_CHARS;
  return ACTION_MAX_CHARS;
}

// Counted the way the routes count: the trimmed text.
export function textLength(text: string): number {
  return text.trim().length;
}

export function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

// The refusal a route gives a text over its limit, with both numbers.
export function tooLongMessage(what: string, max: number, length: number): string {
  return `${what} can be up to ${formatCount(max)} characters; this one has ${formatCount(length)}. Shorten it and send it again.`;
}

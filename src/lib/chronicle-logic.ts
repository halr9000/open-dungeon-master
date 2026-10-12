// What the Chronicle beside the battle map shows, and when it moves
// (issues 212 and 213). Pure: scripts/test-chronicle.mjs.
import type { CampaignMessage } from "@/lib/db/messages";
import { JOIN_NOTE_PREFIX, LEAD_NOTE_PREFIX } from "@/lib/campaign-types";

// The newest entries the scroll holds. It held 14 beside a short board; the
// pane now runs the full height of the fight stage (issue 213), so it holds
// more, and anything older is a click away in the story view.
export const CHRONICLE_ENTRIES = 40;

type Entry = Pick<CampaignMessage, "id" | "authorType" | "dmTurnId" | "content">;

// Narration, the party's lines and the table's notes: every message but the
// system line a halted DM turn leaves (it belongs to the turn, not the tale).
// `earlier` counts what the window leaves out.
export function chronicleWindow<M extends Entry>(
  messages: readonly M[],
  limit = CHRONICLE_ENTRIES,
): { recent: M[]; earlier: number } {
  const eligible = messages.filter((message) => message.authorType !== "system" || !message.dmTurnId);
  return { recent: eligible.slice(-limit), earlier: Math.max(0, eligible.length - limit) };
}

// Everything that changes what the scroll draws, as one string. The scroll
// used to follow its entry COUNT, which stops moving once the window is
// full (a new entry pushes the oldest out) and never moves for an edit, so
// the newest passage slid below the fold (issue 212). Ids and lengths catch
// both; `rolls` catches a roll card that lands after its passage.
export function chronicleSignature(recent: ReadonlyArray<Pick<CampaignMessage, "id" | "content">>, rolls: number): string {
  return `${recent.map((message) => `${message.id}:${message.content.length}`).join("|")}#${rolls}`;
}

// How close to the end still counts as reading the latest. A reader above
// it has scrolled back on purpose and is left where they are.
export const FOLLOW_SLACK_PX = 48;

export function atBottom(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  slack = FOLLOW_SLACK_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= slack;
}

// A system line as the scroll shows it, whole (PR 232: it used to be cut at
// 200 characters, so an enemy turn naming two attacks showed one). The
// transcript draws the lead's direction and a joiner as cards from their
// stored prefixes (src/lib/campaign-types.ts); the scroll has no cards, so
// the prefixes become words.
export function chronicleSystemLine(content: string): string {
  if (content.startsWith(LEAD_NOTE_PREFIX)) {
    return `Party lead: ${content.slice(LEAD_NOTE_PREFIX.length)}`;
  }
  if (content.startsWith(JOIN_NOTE_PREFIX)) {
    return content.slice(JOIN_NOTE_PREFIX.length);
  }
  return content;
}

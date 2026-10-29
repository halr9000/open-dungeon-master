// Where the workshop is, as a URL (audit finding WF-11): which tool is
// open, WorldForge's view and entry, the record a tool was asked to open,
// and the World entry to go back to. Kept in the URL rather than in a
// panel's state, so refresh and Back land where the author was, and a link
// to an exact record can be shared. Pure.

export type WorkshopPlace = {
  // The tool (src/app/workshop/[workshopId]/systems.ts ids).
  system?: string | null;
  // WorldForge's view (wiki, web, timeline...) and the entry open in it.
  view?: string | null;
  entry?: string | null;
  // The record the tool opens on arrival, by its own id.
  open?: string | null;
  // The World entry ("npc:<id>"...) the author came from, offered back.
  from?: string | null;
};

const ORDER = ["system", "view", "entry", "open", "from"] as const;

export function workshopHref(pathname: string, place: WorkshopPlace): string {
  const query = new URLSearchParams();
  for (const key of ORDER) {
    const value = place[key];
    if (value) query.set(key, value);
  }
  const text = query.toString();
  return text ? `${pathname}?${text}` : pathname;
}

// The WorldForge entry of a record, as the place to go to.
export const worldEntryPlace = (ref: string): WorkshopPlace => ({ system: "world", view: "wiki", entry: ref });

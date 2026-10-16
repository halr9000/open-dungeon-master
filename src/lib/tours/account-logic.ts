// Which walkthroughs a person has finished, as the account holds it and as
// a device caches it (issue #306). Pure: the store hands over localStorage,
// the tests a Map. No "@/" imports here: scripts/test-tours.mjs loads it
// straight from disk.
//
// Finishing a tour used to set one localStorage flag, odm:tour:<id>. That
// flag belonged to a browser profile at one address, not to a person: the
// same account met every tour again in the desktop app, on a phone, or at
// the server's other address, and a second account on a shared machine
// never met them at all. The account now holds the record and the device
// keeps a copy per account, with what it has not yet managed to save.

// How a tour was closed: Done on its last step, or ended early (End the
// tour, Escape, a tap outside the card, the back gesture). Either one
// finishes it; a tour that was only shown, or that the page navigated
// away from, is not finished and opens again.
export type TourEnd = "done" | "ended";

export type TourRecord = { version: number; how: TourEnd; at: string };

// Tour id to the newest version finished.
export type TourLedger = Record<string, TourRecord>;

export function parseLedger(raw: unknown, isKnown: (id: string) => boolean): TourLedger {
  const out: TourLedger = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isKnown(id) || !value || typeof value !== "object") {
      continue;
    }
    const record = value as Partial<TourRecord>;
    const version = Number(record.version);
    if (!Number.isInteger(version) || version < 1) {
      continue;
    }
    out[id] = {
      version,
      how: record.how === "ended" ? "ended" : "done",
      at: typeof record.at === "string" ? record.at : "",
    };
  }
  return out;
}

// The union, keeping the higher version of a tour finished in both; on a
// tie the earlier ledger's record stands, so a second finish of the same
// version does not rewrite when the first happened.
export function mergeLedgers(...ledgers: TourLedger[]): TourLedger {
  const out: TourLedger = {};
  for (const ledger of ledgers) {
    for (const [id, record] of Object.entries(ledger)) {
      if (!out[id] || record.version > out[id].version) {
        out[id] = record;
      }
    }
  }
  return out;
}

export function finished(ledger: TourLedger, tourId: string, version: number): boolean {
  return (ledger[tourId]?.version ?? 0) >= version;
}

// ---- the device's copy ----

export interface TourStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// done: every finish this device knows of for the account, saved or not.
// pending: the finishes the account has not acknowledged yet, sent again
// until it does.
export type DeviceLedger = { done: TourLedger; pending: TourLedger };

export function deviceKey(userId: string): string {
  return `odm:tours:${userId}`;
}

export function readDevice(store: TourStore, userId: string, isKnown: (id: string) => boolean): DeviceLedger {
  try {
    const raw = store.getItem(deviceKey(userId));
    const parsed = raw ? (JSON.parse(raw) as { done?: unknown; pending?: unknown }) : null;
    return { done: parseLedger(parsed?.done, isKnown), pending: parseLedger(parsed?.pending, isKnown) };
  } catch {
    return { done: {}, pending: {} };
  }
}

export function writeDevice(store: TourStore, userId: string, device: DeviceLedger): void {
  try {
    store.setItem(deviceKey(userId), JSON.stringify(device));
  } catch {
    // Storage refused: the copy in memory carries this page.
  }
}

// What the account acknowledged leaves pending; everything it holds joins
// done, so another tab that read the account earlier still finds it here.
// An id the server would not record (a newer page against an older server)
// leaves pending too, rather than being sent again forever.
export function settle(device: DeviceLedger, account: TourLedger, ignored: readonly string[] = []): DeviceLedger {
  const pending: TourLedger = {};
  for (const [id, record] of Object.entries(device.pending)) {
    if (!finished(account, id, record.version) && !ignored.includes(id)) {
      pending[id] = record;
    }
  }
  return { done: mergeLedgers(device.done, account, device.pending), pending };
}

// ---- the old per-browser flag ----

export function legacyKey(tourId: string): string {
  return `odm:tour:${tourId}`;
}

// The flags a browser set before the account kept the record, for the tours
// this server knows. Read once, by the first account to load on the device,
// and removed, so they move to that account rather than hiding the tours
// from every account that signs in after it. The app's own shell tour
// (odm:tour:app in the client) is not a server tour and is left alone.
export function takeLegacy(store: TourStore, tourIds: readonly string[], at: string): TourLedger {
  const out: TourLedger = {};
  for (const id of tourIds) {
    try {
      if (store.getItem(legacyKey(id)) === "done") {
        out[id] = { version: 1, how: "done", at };
        store.removeItem(legacyKey(id));
      }
    } catch {
      // Storage refused: nothing to carry over.
    }
  }
  return out;
}

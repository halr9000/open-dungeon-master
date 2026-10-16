"use client";

// Whether a walkthrough has been finished, for the pages that open one by
// themselves (issue #306). The account holds the record (GET and POST
// /api/profile/tours); this device keeps a copy per account in localStorage
// (src/lib/tours/account-logic.ts) holding what it has finished and what the
// account has not acknowledged yet.
//
// The answer is null until the account has answered on this page: a tour
// opens by itself only on a definite "not finished", so a slow or failed
// read never shows a tour again. Every page that asks reads the account
// afresh when it mounts (one small request, shared by the pages mounting
// together), because the app's screens can move to another server, and so
// another account, without reloading this module. Another tab's finish
// arrives through the storage event. A finish the account did not take is
// kept on the device and sent again: on the next read, when the browser is
// back online, and on a backing-off timer.
//
// A server from before this record answers 404; the page then keeps the old
// per-browser flag (odm:tour:<id>), so tours still open once there.

import { useEffect, useSyncExternalStore } from "react";
import {
  deviceKey,
  finished,
  legacyKey,
  mergeLedgers,
  parseLedger,
  readDevice,
  settle,
  takeLegacy,
  writeDevice,
  type DeviceLedger,
  type TourEnd,
  type TourLedger,
  type TourStore,
} from "@/lib/tours/account-logic";
import { TOUR_IDS, isTourId, tourVersion } from "@/lib/tours/registry";

const EVENT = "odm-tours";
// Pages that mount together (the table and its Hand) share one read.
const REUSE_MS = 2_000;
const RETRY_MS = [5_000, 30_000, 120_000];

type Mode = "idle" | "loading" | "account" | "legacy" | "failed";

let mode: Mode = "idle";
let userId = "";
let account: TourLedger = {};
let device: DeviceLedger = { done: {}, pending: {} };
// Finished while the account was unknown (a tour replayed from Help and
// closed while the first read was in flight): folded into the account's
// copy once it answers.
let early: TourLedger = {};
let reading: Promise<void> | null = null;
let readAt = 0;
let flushing = false;
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function storage(): TourStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function emit() {
  window.dispatchEvent(new Event(EVENT));
}

function loadDevice() {
  const store = storage();
  if (store && userId) {
    device = readDevice(store, userId, isTourId);
  }
}

function saveDevice() {
  const store = storage();
  if (store && userId) {
    writeDevice(store, userId, device);
  }
}

function listen() {
  if (listening) {
    return;
  }
  listening = true;
  window.addEventListener("storage", (event) => {
    if (mode === "account" && userId && event.key === deviceKey(userId)) {
      loadDevice();
      emit();
    } else if (mode === "legacy" && event.key?.startsWith(legacyKey(""))) {
      emit();
    }
  });
  window.addEventListener("online", () => {
    if (mode === "failed") {
      refreshTours(true);
    } else {
      void flush();
    }
  });
}

function scheduleRetry() {
  if (retryTimer) {
    return;
  }
  const delay = RETRY_MS[Math.min(retries, RETRY_MS.length - 1)];
  retries += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (mode === "failed") {
      refreshTours(true);
    } else {
      void flush();
    }
  }, delay);
}

// Reads the account's record. Called by every page that asks, on mount.
export function refreshTours(force = false): void {
  listen();
  if (reading || (!force && mode !== "failed" && mode !== "idle" && Date.now() - readAt < REUSE_MS)) {
    return;
  }
  mode = "loading";
  emit();
  reading = fetch("/api/profile/tours", { cache: "no-store" })
    .then(async (response) => {
      if (response.status === 404) {
        mode = "legacy";
        for (const id of Object.keys(early)) {
          try {
            window.localStorage.setItem(legacyKey(id), "done");
          } catch {
            // Storage refused: it opens again next visit, as it always did.
          }
        }
        early = {};
        return;
      }
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      const data = (await response.json()) as { userId?: unknown; tours?: unknown };
      if (typeof data.userId !== "string" || !data.userId) {
        throw new Error("no account");
      }
      userId = data.userId;
      account = parseLedger(data.tours, isTourId);
      loadDevice();
      const store = storage();
      const legacy = store ? takeLegacy(store, TOUR_IDS, new Date().toISOString()) : {};
      const pending = mergeLedgers(device.pending, legacy, early);
      device = settle({ done: mergeLedgers(device.done, pending), pending }, account);
      early = {};
      saveDevice();
      mode = "account";
    })
    .catch((error: unknown) => {
      console.warn("[tours] could not read the finished tours; none opens by itself until they are", error);
      mode = "failed";
      scheduleRetry();
    })
    .finally(() => {
      reading = null;
      readAt = Date.now();
      emit();
      void flush();
    });
}

async function flush() {
  if (flushing || mode !== "account" || !userId) {
    return;
  }
  const entries = Object.entries(device.pending);
  if (!entries.length) {
    return;
  }
  flushing = true;
  const forUser = userId;
  try {
    const response = await fetch("/api/profile/tours", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        finished: entries.map(([id, record]) => ({ id, version: record.version, how: record.how })),
      }),
    });
    if (!response.ok) {
      throw new Error(String(response.status));
    }
    const data = (await response.json()) as { userId?: unknown; tours?: unknown; ignored?: unknown };
    if (data.userId !== forUser || userId !== forUser) {
      return;
    }
    account = parseLedger(data.tours, isTourId);
    loadDevice();
    const ignored = Array.isArray(data.ignored) ? data.ignored.filter((id): id is string => typeof id === "string") : [];
    device = settle(device, account, ignored);
    saveDevice();
    retries = 0;
    emit();
  } catch (error) {
    // Kept on the device: this tour stays closed here, and the account is
    // asked again.
    console.warn("[tours] could not save a finished tour to the account; it is kept on this device and sent again", error);
    scheduleRetry();
  } finally {
    flushing = false;
  }
}

// True when this account finished the tour at its current version, false
// when it did not, null while that is not known.
export function tourFinished(tourId: string): boolean | null {
  if (mode === "legacy") {
    try {
      return window.localStorage.getItem(legacyKey(tourId)) === "done";
    } catch {
      return true;
    }
  }
  const version = tourVersion(tourId);
  if (finished(early, tourId, version)) {
    return true;
  }
  if (mode !== "account") {
    return null;
  }
  return finished(account, tourId, version) || finished(device.done, tourId, version);
}

// Done on the last step or ended early: either way the tour is finished
// for this account, here at once and on the account as soon as it answers.
export function finishTour(tourId: string, how: TourEnd): void {
  listen();
  const record = { version: tourVersion(tourId), how, at: new Date().toISOString() };
  if (mode === "legacy") {
    try {
      window.localStorage.setItem(legacyKey(tourId), "done");
    } catch {
      // Storage refused: it opens again next visit, as it always did.
    }
    emit();
    return;
  }
  if (mode !== "account") {
    early = mergeLedgers(early, { [tourId]: record });
    emit();
    refreshTours();
    return;
  }
  loadDevice();
  device = {
    done: mergeLedgers(device.done, { [tourId]: record }),
    pending: mergeLedgers(device.pending, { [tourId]: record }),
  };
  saveDevice();
  emit();
  void flush();
}

function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  return () => window.removeEventListener(EVENT, callback);
}

// The hook the tour hosts read. A tour opens by itself only on false.
export function useTourFinished(tourId: string): boolean | null {
  useEffect(() => {
    refreshTours();
  }, []);
  return useSyncExternalStore(subscribe, () => tourFinished(tourId), () => null);
}

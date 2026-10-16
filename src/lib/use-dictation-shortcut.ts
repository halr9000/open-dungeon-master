"use client";

import { useSyncExternalStore } from "react";
import { DICTATION_SHORTCUT_KEY, parseChord, serializeChord, type DictationChord } from "@/lib/dictation-shortcut";

// The hold-to-dictate key (issue 291), kept in this device's localStorage
// beside the microphone and push-to-talk choices (useVoicePrefs.ts), never
// on the account: a key that suits one keyboard or app can clash in
// another. Read through useSyncExternalStore with the native storage event,
// as dice-sources.ts is, so the settings field and the table's mic (the
// apps lay Settings over a table in play) agree the moment it changes.

const EVENT = "odm-dictation-shortcut";

// Cached on the raw stored string, so a read between writes returns the same
// object and useSyncExternalStore does not loop.
let cachedRaw: string | null = null;
let cached: DictationChord | null = null;

export function readDictationShortcut(): DictationChord | null {
  if (typeof window === "undefined") {
    return null;
  }
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(DICTATION_SHORTCUT_KEY);
  } catch {
    return null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parseChord(raw);
  }
  return cached;
}

export function writeDictationShortcut(chord: DictationChord | null) {
  try {
    if (chord) {
      window.localStorage.setItem(DICTATION_SHORTCUT_KEY, serializeChord(chord));
    } else {
      window.localStorage.removeItem(DICTATION_SHORTCUT_KEY);
    }
  } catch {
    // Private browsing and similar: the shortcut lasts as long as the page.
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

export function useDictationShortcut(): DictationChord | null {
  return useSyncExternalStore(subscribe, readDictationShortcut, () => null);
}

// While a settings field listens for a new key, the table's shortcut stands
// down, so pressing the old one there does not start a take underneath.
let listening = 0;

export function setListeningForShortcut(on: boolean) {
  listening = Math.max(0, listening + (on ? 1 : -1));
}

export function listeningForShortcut(): boolean {
  return listening > 0;
}

// Option, not Alt, on a Mac keyboard. Read after hydration (the server
// render has no navigator), and it never changes.
export function useMacKeyboard(): boolean {
  return useSyncExternalStore(noSubscription, isMacKeyboard, () => false);
}

function isMacKeyboard(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

function noSubscription() {
  return () => {};
}

"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { matchesChord, releasesChord, type DictationChord } from "@/lib/dictation-shortcut";
import { listeningForShortcut } from "@/lib/use-dictation-shortcut";

// The composer's mic, held from the keyboard (issue 291). Pressing the
// player's dictation key starts the same take as pressing the mic; letting
// go of it (or of a modifier it holds) ends the take, and the words go into
// the box like the mic's. It never sends: the key's own presses are
// swallowed before the box or any other shortcut sees them, so it types
// nothing and cannot reach Enter's send.
//
// It answers in the message box, and anywhere at the table that is not
// another field, a dialog or a menu, while the box is on screen with
// nothing over it. Repeats are ignored; losing the window, hiding the page,
// the box going away or the key changing all end a take at once.

const AWAY = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"], dialog';

function editable(element: Element): boolean {
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (element as HTMLElement).isContentEditable === true;
}

// Whether a press there is meant for the table's box: in the box itself, or
// on the table with the box showing and uncovered.
function reaches(target: EventTarget | null, box: HTMLTextAreaElement | null): boolean {
  if (!box || box.disabled) {
    return false;
  }
  if (target === box) {
    return true;
  }
  const element = target instanceof Element ? target : null;
  if (element && (editable(element) || element.closest(AWAY))) {
    return false;
  }
  const rect = box.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return false;
  }
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
    return false;
  }
  const top = document.elementFromPoint(x, y);
  const well = box.closest("[data-tour='composer-input']") ?? box;
  return Boolean(top && well.contains(top));
}

export function useHoldToDictate({
  chord,
  composerRef,
  start,
  stop,
  busy,
}: {
  // Null when no key is set, or the mic cannot take a turn now.
  chord: DictationChord | null;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  start: () => Promise<void> | void;
  stop: () => void;
  // A take still being written down: a press then starts nothing.
  busy: boolean;
}): boolean {
  const [held, setHeld] = useState(false);
  const startRef = useRef(start);
  const stopRef = useRef(stop);
  const busyRef = useRef(busy);
  // At commit, not after paint: the apps' Preact runs a plain effect a frame
  // or more later, and a press in that gap, just after the words landed,
  // was taken for a press while still writing them down.
  useLayoutEffect(() => {
    startRef.current = start;
    stopRef.current = stop;
    busyRef.current = busy;
  });

  useEffect(() => {
    if (!chord) {
      return;
    }
    // A take this key started, and whether the key itself is still down
    // (its repeats are swallowed until it comes up, even after a modifier
    // let go first and ended the take).
    let holding = false;
    let pressed = false;
    const release = () => {
      if (holding) {
        holding = false;
        setHeld(false);
        stopRef.current();
      }
    };
    const swallow = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const down = (event: KeyboardEvent) => {
      if (event.isComposing) {
        return;
      }
      if (pressed && event.code === chord.code) {
        swallow(event);
        return;
      }
      if (!matchesChord(event, chord) || listeningForShortcut() || !reaches(event.target, composerRef.current)) {
        return;
      }
      swallow(event);
      pressed = true;
      if (event.repeat || holding || busyRef.current) {
        return;
      }
      holding = true;
      setHeld(true);
      void startRef.current();
    };
    const up = (event: KeyboardEvent) => {
      if (pressed && event.code === chord.code) {
        pressed = false;
        swallow(event);
      }
      if (holding && releasesChord(event, chord)) {
        release();
      }
    };
    const away = () => {
      pressed = false;
      release();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") {
        away();
      }
    };
    // Capture, on the window: ahead of the box's own Enter and every other
    // key handler on the page.
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", away);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", away);
      document.removeEventListener("visibilitychange", hidden);
      away();
    };
  }, [chord, composerRef]);

  return held;
}

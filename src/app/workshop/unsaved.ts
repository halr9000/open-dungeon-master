"use client";

import { useEffect } from "react";
import { appConfirm } from "@/components/ui/ConfirmDialog";

// Editors with changes not saved yet (audit finding WF-21): switching tools
// or entries in the workshop remounts the editor and loses its draft, so
// the workshop asks first. Each open editor says whether its draft differs
// from what it opened with; leaving the page while one does gets the
// browser's own "leave this page?" as well. The browser's Back button is
// the one way out not asked about: the app router cannot hold it.

const dirty = new Set<symbol>();

function warnOnLeave(event: BeforeUnloadEvent) {
  event.preventDefault();
}

export function useUnsavedDraft(isDirty: boolean) {
  useEffect(() => {
    if (!isDirty) return;
    const key = Symbol("draft");
    dirty.add(key);
    if (dirty.size === 1) window.addEventListener("beforeunload", warnOnLeave);
    return () => {
      dirty.delete(key);
      if (dirty.size === 0) window.removeEventListener("beforeunload", warnOnLeave);
    };
  }, [isDirty]);
}

// Whether the workshop may move on: yes when nothing is unsaved, or when
// the author says to leave the changes behind.
export async function mayLeaveDrafts(): Promise<boolean> {
  if (dirty.size === 0) return true;
  return appConfirm("An editor here has changes that are not saved. Leave them and go on?", {
    title: "Leave without saving?",
    actionLabel: "Leave them",
    tone: "danger",
  });
}

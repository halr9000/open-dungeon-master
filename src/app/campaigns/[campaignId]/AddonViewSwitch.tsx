"use client";

import { SlidersHorizontal } from "lucide-react";
import { useCallback, useState, type CSSProperties } from "react";
import { AddonFields, type FieldValues } from "@/components/addons/AddonFields";
import { Dialog } from "@/components/ui/Dialog";
import type { OfferedBoardView } from "@/lib/addons/offered";
import { cn } from "@/lib/cn";

// Which way this device draws the board: the built-in grid, or a board view
// an addon offers (a 3D table, an isometric one). Remembered per device, like
// the theme; a view that is no longer offered falls back to the grid. A view
// with options of its own (a pixel scale, a quality tier for a slower
// computer) gets a button beside it; what this device chose is kept here too
// and handed to the view in its snapshot, since the view's sandboxed frame
// cannot keep anything itself.

const KEY = "odm.boardView";
const OPTIONS_KEY = "odm.boardViewOptions";

export function boardViewKey(view: Pick<OfferedBoardView, "addonId" | "id">): string {
  return `${view.addonId}:${view.id}`;
}

export function useBoardViewChoice(): [string, (next: string) => void] {
  const [choice, setChoice] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      return window.localStorage.getItem(KEY) ?? "";
    } catch {
      return "";
    }
  });
  const choose = useCallback((next: string) => {
    setChoice(next);
    try {
      if (next) window.localStorage.setItem(KEY, next);
      else window.localStorage.removeItem(KEY);
    } catch {
      // A private window keeps the choice for this page only.
    }
  }, []);
  return [choice, choose];
}

type StoredOptions = Record<string, FieldValues>;

function readStoredOptions(): StoredOptions {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(OPTIONS_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as StoredOptions) : {};
  } catch {
    return {};
  }
}

// What this device chose for each view's options, by view key. The values
// are checked against the view's fields where they are used (board-bridge.ts).
export function useBoardViewOptions(): [StoredOptions, (viewKey: string, key: string, value: string | number | boolean) => void] {
  const [stored, setStored] = useState<StoredOptions>(readStoredOptions);
  const change = useCallback((viewKey: string, key: string, value: string | number | boolean) => {
    setStored((current) => {
      const next = { ...current, [viewKey]: { ...current[viewKey], [key]: value } };
      try {
        window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
      } catch {
        // A private window keeps the choice for this page only.
      }
      return next;
    });
  }, []);
  return [stored, change];
}

export function AddonViewSwitch({
  views,
  value,
  onChange,
  stored = {},
  onOption,
}: {
  views: OfferedBoardView[];
  value: string;
  onChange: (next: string) => void;
  // What this device chose for each view's options (useBoardViewOptions).
  stored?: StoredOptions;
  onOption?: (viewKey: string, key: string, value: string | number | boolean) => void;
}) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  if (!views.length) return null;
  const active = views.find((view) => boardViewKey(view) === value) ?? null;
  const options = [{ key: "", label: "Board", hint: "The built-in board" }, ...views.map((view) => ({ key: boardViewKey(view), label: view.title, hint: `${view.description || view.title}, from ${view.addonName}` }))];
  // Shaped like the Move pills beside it (BoardMoveModes.tsx), in the board
  // chrome's fixed colours: the board stays dark in the day theme, where the
  // amber scale turns dark brown and would vanish here.
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="How the board is drawn" data-pill-group="">
      <span className="text-[10px] uppercase tracking-[0.18em] text-[#8a86a6]">View</span>
      {options.map((option, index) => {
        const on = value === option.key;
        return (
          <button
            key={option.key || "grid"}
            type="button"
            role="radio"
            aria-checked={on}
            data-on={on ? "" : undefined}
            title={option.hint}
            style={{ "--i": index } as CSSProperties}
            onClick={() => onChange(option.key)}
            className={cn(
              "hand-option motion-press motion-pop inline-flex min-h-8 items-center rounded-full border px-2.5 text-[11px]",
              on
                ? "border-[rgba(212,171,58,0.7)] bg-[rgba(212,171,58,0.2)] text-[#f9ecc8]"
                : "border-[rgba(107,99,148,0.5)] text-[#aeaac6] hover:border-[rgba(212,171,58,0.6)] hover:text-[#e9e6f4]",
            )}
          >
            {option.label}
          </button>
        );
      })}
      {active?.options.length && onOption ? (
        <>
          <button
            type="button"
            onClick={() => setOptionsOpen(true)}
            aria-label={`${active.title} options`}
            title={`${active.title} options`}
            className="motion-press inline-flex min-h-8 items-center gap-1 rounded-full border border-[rgba(107,99,148,0.5)] px-2.5 text-[11px] text-[#aeaac6] hover:border-[rgba(212,171,58,0.6)] hover:text-[#e9e6f4]"
          >
            <SlidersHorizontal className="size-3.5" aria-hidden="true" />
            Options
          </button>
          <Dialog open={optionsOpen} onOpenChange={setOptionsOpen} title={`${active.title} options`}>
            <p className="mb-3 text-xs leading-5 text-stone-400">
              For this device only, from {active.addonName}. They change how the board is drawn here, nothing else.
            </p>
            <AddonFields
              idPrefix={`view-${active.addonId}-${active.id}`}
              fields={active.options}
              values={{ ...Object.fromEntries(active.options.map((field) => [field.key, field.default])), ...stored[boardViewKey(active)] }}
              onChange={(key, next) => onOption(boardViewKey(active), key, next)}
            />
          </Dialog>
        </>
      ) : null}
    </div>
  );
}

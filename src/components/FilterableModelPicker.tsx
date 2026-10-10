"use client";

import { ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { ui } from "@/lib/ui";

// A model picker for lists too long for a menu: OpenRouter lists hundreds,
// and scrolling a select that size finds nothing. A typeahead field instead:
// typing narrows the list to its top matches, arrow keys walk them, Enter
// picks, Escape closes, and a newest-first sort puts a provider's latest at
// the top. Pure helpers are exported for tests.

export type PickerModel = {
  id: string;
  label: string;
  // Unix seconds when the provider added the model, when it says
  // (ListedModel.created). Models without it sort last in the newest view.
  created?: number;
  context?: number;
};

export type ModelSort = "newest" | "server";

// Case-insensitive substring on id and display name; blank means everything.
export function matchesQuery(model: PickerModel, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return model.id.toLowerCase().includes(needle) || model.label.toLowerCase().includes(needle);
}

// Newest first by `created`; a model without a date is unknown age and goes
// after every dated one (ties break by id, so the order never flickers).
export function sortModels(models: readonly PickerModel[], sort: ModelSort): PickerModel[] {
  if (sort === "server") {
    return [...models];
  }
  const dated = models.filter((model): model is PickerModel & { created: number } => typeof model.created === "number");
  const undated = models.filter((model) => typeof model.created !== "number");
  dated.sort((a, b) => b.created - a.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  undated.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [...dated, ...undated];
}

export function filterModels(models: readonly PickerModel[], query: string, sort: ModelSort): PickerModel[] {
  return sortModels(models.filter((model) => matchesQuery(model, query)), sort);
}

const MAX_SHOWN = 20;

export function FilterableModelPicker({
  models,
  value,
  onChange,
  placeholder,
  label = "Model",
  className,
}: {
  models: PickerModel[];
  value: string;
  onChange: (model: string) => void;
  placeholder?: string;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [sort, setSort] = useState<ModelSort>("newest");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const listRef = useRef<HTMLUListElement | null>(null);

  const chosen = models.find((model) => model.id === value);
  // The rows as typed right now; the query only ever narrows, never saves.
  const results = useMemo(() => filterModels(models, query, sort), [models, query, sort]);
  const shown = results.slice(0, MAX_SHOWN);

  // Clicking elsewhere closes the list without changing anything.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (!boxRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Keep the highlighted row where the keys can see it.
  useEffect(() => {
    listRef.current?.children[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  function pick(model: PickerModel) {
    onChange(model.id);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setHighlight((at) => Math.min(at + 1, shown.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((at) => Math.max(at - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = shown[highlight];
      if (open && row) {
        pick(row);
      } else {
        setOpen(true);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={boxRef} role="group" aria-label={label} className={cn("reveal block", className)}>
      <span className="mb-1 block text-xs font-medium text-stone-400">{label}</span>
      <div className="relative" data-open={open || undefined}>
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-500" aria-hidden="true">
          <Search className="size-4" />
        </span>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          className={cn(ui.input, "w-full pl-8 pr-8")}
          value={open ? query : chosen?.label ?? value}
          placeholder={placeholder ?? "Search models…"}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? "Close the model list" : "Open the model list"}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-stone-500 hover:text-stone-300"
          onClick={() => setOpen((was) => !was)}
        >
          <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
        </button>
        {open ? (
          <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-stone-800 bg-stone-950/95 shadow-xl backdrop-blur">
            <div className="flex items-center justify-between border-b border-stone-800/70 px-2.5 py-1.5">
              <span className="text-[11px] text-stone-500">
                {results.length ? `${results.length} ${results.length === 1 ? "model" : "models"}` : "No models match"}
                {results.length > MAX_SHOWN ? ` · first ${MAX_SHOWN}` : ""}
              </span>
              <button
                type="button"
                className="text-[11px] text-amber-200 hover:text-amber-100"
                onClick={() => {
                  setSort((was) => (was === "newest" ? "server" : "newest"));
                  setHighlight(0);
                }}
              >
                Sort: {sort === "newest" ? "newest" : "server"}
              </button>
            </div>
            <ul id={listId} ref={listRef} role="listbox" aria-label={label} className="max-h-64 overflow-y-auto py-1">
              {shown.map((model, at) => (
                <li key={model.id} role="option" aria-selected={model.id === value}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-baseline justify-between gap-2 px-2.5 py-1.5 text-left text-sm",
                      at === highlight ? "bg-stone-800/80 text-stone-100" : "text-stone-300 hover:bg-stone-800/40",
                    )}
                    onMouseEnter={() => setHighlight(at)}
                    onClick={() => pick(model)}
                  >
                    <span className="min-w-0 truncate">{model.label}</span>
                    <span className="shrink-0 font-mono text-[10px] text-stone-500">{model.id}</span>
                  </button>
                </li>
              ))}
              {!shown.length ? <li className="px-2.5 py-2 text-xs text-stone-500">Type less, or switch the sort.</li> : null}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

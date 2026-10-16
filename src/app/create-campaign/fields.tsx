"use client";

import { ChevronDown } from "lucide-react";
import { useId, type ReactNode } from "react";
import { GameIcon } from "@/components/ui/GameIcon";
import { cn } from "@/lib/cn";
import { ui } from "@/lib/ui";

// The wizard's shared field vocabulary: the same input recipe as the rest of
// the app and the two-line toggle card the old single-page dialog used for
// every on/off decision, kept so the settings read the same as they always
// did, just paced across steps.

export const inputClass = ui.input;

export function toggleClass(active: boolean) {
  return cn(
    "flex-1 rounded-lg border px-3 py-2 text-left transition-colors",
    active
      ? "border-amber-200/40 bg-amber-200/10 text-amber-100"
      : "border-stone-800 text-stone-400 hover:border-stone-600",
  );
}

export function ToggleCard({
  active,
  onClick,
  label,
  hint,
  disabled = false,
  className,
}: {
  active: boolean;
  onClick: () => void;
  label: ReactNode;
  hint: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={active}
      className={cn(toggleClass(active), disabled && "cursor-not-allowed opacity-50", className)}
    >
      <span className="block font-medium">{label}</span>
      <span className="block text-xs opacity-80">{hint}</span>
    </button>
  );
}

// Section label above a field or a group of them.
export function FieldLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("mb-1 block text-stone-400", className)}>{children}</span>;
}

// A named group of settings that can be left closed: its name, a line that
// says what is set inside, and the fields. Closed, the fields stay mounted
// (only hidden), so a picker keeps what it fetched and a half-typed line
// keeps its text; the draft is the record either way. The dialog holds which
// groups are open, so the review step can open one to edit it.
export function DetailGroup({
  id,
  title,
  summary,
  glyph,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  summary: ReactNode;
  glyph?: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  const bodyId = useId();
  return (
    <section className="cc-group" data-open={open || undefined} data-group={id}>
      <button
        type="button"
        className="cc-group-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onToggle(!open)}
      >
        {glyph ? <GameIcon icon={{ kind: "glyph", key: glyph }} size="size-5" className="shrink-0" /> : null}
        <span className="min-w-0 flex-1">
          <span className="cc-group-title">{title}</span>
          <span className="cc-group-summary">{summary}</span>
        </span>
        <ChevronDown className="cc-group-chevron size-4 shrink-0" aria-hidden="true" />
      </button>
      <div id={bodyId} role="region" aria-label={title} hidden={!open} className="cc-group-body space-y-4">
        {children}
      </div>
    </section>
  );
}

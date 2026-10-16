"use client";

import { Zap } from "lucide-react";
import { Field, SelectField } from "@/app/admin/AdminSettingsFields";
import { FAST_COST_NOTE, type Speed, type SpeedEligibility } from "@/lib/speed-tier";
import type { SpeedNote } from "@/lib/speed-status";

// Processing speed for one model role (issue 255): the provider's default or
// its paid Fast tier. Offered on a connection that has one, for a named
// model (src/lib/speed-tier.ts); otherwise it says why. The cost is said before Fast is chosen, and what
// the last calls actually ran at is shown under it, so a downgrade to
// standard speed is never read as Fast.
export function SpeedField({
  label,
  value,
  onChange,
  eligibility,
  note,
}: {
  label: string;
  value: Speed;
  onChange: (value: Speed) => void;
  eligibility: SpeedEligibility;
  note?: SpeedNote;
}) {
  if (!eligibility.ok) {
    return (
      <Field label={label} hint={eligibility.reason} group>
        <p className="rounded-md border border-stone-800 bg-stone-950/40 px-2.5 py-1.5 text-xs text-stone-400" data-speed-unavailable>
          Provider default{value === "fast" ? " (Fast is set, but this connection has no Fast tier, so none is asked for)" : ""}
        </p>
      </Field>
    );
  }
  return (
    <div data-speed-field>
      <SelectField
        label={label}
        value={value}
        onChange={onChange}
        options={[
          { value: "" as const, label: "Provider default" },
          { value: "fast" as const, label: "Fast (premium price)" },
        ]}
        hint={value === "fast" ? FAST_COST_NOTE : "Fast answers sooner at a premium price; the default keeps today's speed and cost."}
      />
      {value === "fast" ? <SpeedNoteLine note={note} /> : null}
    </div>
  );
}

function SpeedNoteLine({ note }: { note?: SpeedNote }) {
  if (!note) {
    return <p className="mt-1 text-[11px] text-stone-500">No call has run at this setting since the server started.</p>;
  }
  const when = new Date(note.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const text = note.refused
    ? `Last call (${when}): ${note.refused}`
    : note.effective === "fast"
      ? `Last call (${when}) ran at Fast${note.reported && note.reported !== "fast" ? ` (the provider says "${note.reported}")` : ""}.`
      : note.effective === "standard"
        ? `Last call (${when}) asked for Fast but ran at standard speed${note.reported ? ` (the provider says "${note.reported}")` : ""}, and was billed as standard.`
        : `Last call (${when}) asked for Fast; the provider did not say which speed ran.`;
  return (
    <p className="mt-1 flex items-start gap-1 text-[11px] text-stone-400" data-speed-note>
      <Zap className="mt-px size-3 shrink-0 text-amber-300" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}

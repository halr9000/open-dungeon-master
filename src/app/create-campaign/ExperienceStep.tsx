"use client";

import { useRef } from "react";
import { cn } from "@/lib/cn";
import { InfoButton } from "@/components/ui/InfoDialog";
import { replayAnimation } from "@/lib/motion/replay";
import { VARIANT_TOGGLES, VariantRulesFields, REST_LABELS } from "@/app/campaigns/[campaignId]/RulesPanel";
import { DetailGroup } from "@/app/create-campaign/fields";
import { AlliesFields, NarrationFields } from "@/app/create-campaign/NarratorFields";
import { SafetyFields } from "@/app/create-campaign/SafetyFields";
import { SheetRows } from "@/app/create-campaign/SheetRows";
import { VoiceChatFields } from "@/app/create-campaign/VoiceChatFields";
import type { StepProps } from "@/app/create-campaign/draft";
import { groupProps, type GroupControl } from "@/app/create-campaign/groups";
import {
  aiSummary,
  boardSummary,
  bondsSummary,
  playersSummary,
  safetySummary,
  variantSummary,
  voiceChatSummary,
} from "@/app/create-campaign/summaries";
import { countableRows, featuresOn } from "@/app/create-campaign/table-sheet";

// The switches only describe themselves on hover, which a finger never
// makes; this is the same text, reachable by tap and keyboard.
const VARIANT_INFO = `${VARIANT_TOGGLES.map((toggle) => `**${toggle.label}**: ${toggle.tip}`).join("\n\n")}\n\n**Rest lengths**: ${Object.values(REST_LABELS).join("; ")}.`;

// Step 2, the experience: first how the table sounds (narration and who
// voices the characters, side by side), then its atmosphere and a safety
// entry nobody has to hunt for. Everything else waits in named groups, each
// saying on its closed face what it holds. The running total is the old
// table sheet's: the same rows, counted the same way.
export function ExperienceStep(props: StepProps & { active: boolean; groups: GroupControl }) {
  const { draft, gates, active, groups } = props;
  const counter = useRef<HTMLSpanElement>(null);
  // The total answers every press, including one that does not move it.
  const onFlip = () => replayAnimation(counter.current, "cc-count-pop var(--dur-beat) var(--ease-spring)");
  const rows = { ...props, onFlip };
  return (
    <div className={cn("space-y-4 text-sm", active && "cc-live")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="cc-note min-w-0 flex-1 basis-40 leading-relaxed">
          Every group below is optional. A gold dot marks a switch the total counts.
        </p>
        <div className="cc-counter" aria-live="polite">
          <span ref={counter} className="cc-count">
            {featuresOn(draft, gates)}
          </span>
          <span className="flex flex-col">
            <span className="cc-eyebrow text-amber-300">features on</span>
            <span className="cc-note">of {countableRows(gates)} counted</span>
          </span>
        </div>
      </div>

      <section className="cc-field" aria-labelledby="cc-voices-head">
        <div className="cc-field-head">
          <span id="cc-voices-head" className="cc-eyebrow">
            Narration and character voices
          </span>
          <span className="cc-note">read aloud by this server</span>
        </div>
        <NarrationFields {...rows} />
      </section>

      <section>
        <div className="cc-group-head">
          <span className="cc-eyebrow">Atmosphere</span>
          <span className="cc-group-rule" aria-hidden="true" />
        </div>
        <SheetRows {...rows} keys={["mapsEnabled", "ambienceEnabled", "ambienceAuto", "presentation"]} />
      </section>

      <DetailGroup {...groupProps(groups, "safety")} title="Safety and boundaries" glyph="ui-lock" summary={safetySummary(draft)}>
        <SafetyFields {...props} />
      </DetailGroup>

      <div className="cc-group-head pt-1">
        <span className="cc-eyebrow">More ways to tailor the table</span>
        <span className="cc-group-rule" aria-hidden="true" />
        <span className="cc-note">optional</span>
      </div>
      <div className="space-y-2">
        {gates.aiNarrates ? (
          <DetailGroup {...groupProps(groups, "ai")} title="AI storytelling and allies" glyph="ui-ai" summary={aiSummary(draft)}>
            <SheetRows {...rows} keys={["aiStorySetup", "narrationGuard", "worldSimulation"]} />
            <AlliesFields {...props} />
          </DetailGroup>
        ) : null}
        <DetailGroup {...groupProps(groups, "bonds")} title="Bonds and romance" glyph="tab-bonds" summary={bondsSummary(draft)}>
          <SheetRows {...rows} keys={["relationships", "romance"]} />
        </DetailGroup>
        <DetailGroup
          {...groupProps(groups, "players")}
          title="Players and permissions"
          glyph="tab-party"
          summary={playersSummary(draft, gates)}
        >
          <SheetRows
            {...rows}
            keys={["multiCharacter", "midGameJoinOpen", "holdSubmissions", "inventoryApprovals", "vitalsApprovals"]}
          />
          <p className="cc-note leading-relaxed">
            Characters per player is a three-way switch: press it again to go from one at a time to all at once.
          </p>
        </DetailGroup>
        <DetailGroup {...groupProps(groups, "board")} title="The battle board" glyph="tab-battle" summary={boardSummary(draft)}>
          <SheetRows {...rows} keys={["boardDrawing", "enemyIntent"]} />
        </DetailGroup>
        <DetailGroup {...groupProps(groups, "variants")} title="Variant rules" glyph="system-rules" summary={variantSummary(draft)}>
          <p className="flex items-center gap-1 text-xs text-stone-500">
            Optional rules from the 5e books, each off unless you turn it on.
            <InfoButton label="Variant rules" text={VARIANT_INFO} />
          </p>
          <VariantRulesFields value={draft.variantRules} onChange={(variantRules) => props.patch({ variantRules })} />
        </DetailGroup>
        {/* A solo table has nobody to talk to. Live voice chat is people
            talking to each other, not the narration above. */}
        {!gates.solo ? (
          <DetailGroup {...groupProps(groups, "voiceChat")} title="Live voice chat" glyph="ui-voice" summary={voiceChatSummary(draft)}>
            <VoiceChatFields value={draft.voiceChat} onChange={(voiceChat) => props.patch({ voiceChat })} />
          </DetailGroup>
        ) : null}
      </div>
    </div>
  );
}

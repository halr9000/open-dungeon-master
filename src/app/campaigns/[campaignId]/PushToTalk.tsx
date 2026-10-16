"use client";

import { Loader2, Mic } from "lucide-react";
import type { RefObject } from "react";
import { cn } from "@/lib/cn";
import { ariaShortcut, formatChord } from "@/lib/dictation-shortcut";
import { useDictation } from "@/lib/use-dictation";
import { useDictationShortcut, useMacKeyboard } from "@/lib/use-dictation-shortcut";
import { ui } from "@/lib/ui";
import { useHoldToDictate } from "@/app/campaigns/[campaignId]/useHoldToDictate";

// Hold-to-record push-to-talk. On release the clip goes to /api/stt and the
// transcript lands in the composer for the player to confirm and send
// (never auto-submits; friends are usually talking in one room). The
// recording itself is useDictation's, shared with the DM's dictation button.
// The player's dictation key, when one is set in Settings (issue 291),
// holds the same take from the keyboard, and its name sits on the button.
export function PushToTalk({
  disabled,
  onTranscript,
  composerRef,
}: {
  disabled: boolean;
  onTranscript: (text: string) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { state: rawState, hint, start, stop, available } = useDictation({ onTranscript });
  const state = rawState === "starting" ? "idle" : rawState;
  const shortcut = useDictationShortcut();
  const mac = useMacKeyboard();
  const keyed = useHoldToDictate({
    chord: available && !disabled ? shortcut : null,
    composerRef,
    start,
    stop,
    busy: rawState === "transcribing",
  });

  // No Whisper, no built-in engine and no device recognizer: a mic that can
  // only fail is not offered (Admin > Speech says the buttons are hidden).
  // A take that is live when the engine goes is ended by useDictation, since
  // the button it would be released on is gone.
  if (!available) {
    return null;
  }

  const keyName = shortcut ? formatChord(shortcut, mac) : "";
  const label = keyName ? `Hold to talk, or hold ${keyName}` : "Hold to talk";
  return (
    <div className="relative self-end">
      <button
        type="button"
        disabled={disabled || state === "transcribing"}
        onPointerDown={(event) => {
          event.preventDefault();
          if (!disabled) {
            void start();
          }
        }}
        onPointerUp={stop}
        onPointerLeave={stop}
        onContextMenu={(event) => event.preventDefault()}
        title={keyName ? `${label}. The words wait in the box until you send them.` : label}
        aria-label={label}
        aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
        data-tour="composer-talk"
        // The kit's secondary button without its magnet: a button that follows
        // the pointer would slide out from under a held finger and end the take.
        className={cn(
          ui.btnSecondary.replace("motion-magnet", "motion-press"),
          "session-deskbtn select-none touch-none",
          state === "recording" && "border-red-600/80 bg-red-950/80 text-red-200 shadow-[0_0_16px_rgba(220,38,38,0.35)]",
          (disabled || state === "transcribing") && "opacity-40",
        )}
      >
        {state === "transcribing" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Mic className={cn("size-4", state === "recording" && "animate-pulse")} />
        )}
      </button>
      {keyName && !(state === "error" && hint) ? (
        // The key's name on the button's corner; it lights while held.
        <kbd
          key={keyName}
          aria-hidden="true"
          data-dictation-key={keyName}
          data-held={keyed ? "" : undefined}
          className={cn(
            "reveal-pop pointer-events-none absolute -right-1.5 -top-2 max-w-24 truncate whitespace-nowrap rounded border px-1 font-mono text-[9px] leading-[14px] shadow transition-colors duration-150",
            keyed
              ? "border-red-500/70 bg-red-950 text-red-100"
              : "border-amber-500/40 bg-stone-950 text-amber-100/90",
            disabled && "opacity-40",
          )}
        >
          {keyName}
        </kbd>
      ) : null}
      {state === "error" && hint ? (
        <p className="reveal-pop absolute bottom-full right-0 mb-1 w-64 rounded bg-stone-900 px-2 py-1 text-xs text-red-400 shadow">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// The creator's named groups of optional settings, and which step holds
// each. The dialog keeps which are open, so the review step can open one to
// edit it and a group stays as the person left it when they come back.
export type GroupId =
  | "world"
  | "character"
  | "prep"
  | "safety"
  | "ai"
  | "bonds"
  | "players"
  | "board"
  | "variants"
  | "voiceChat";

export type StepKey = "essentials" | "experience" | "review";

export const GROUP_STEP: Record<GroupId, Exclude<StepKey, "review">> = {
  world: "essentials",
  character: "essentials",
  prep: "essentials",
  safety: "experience",
  ai: "experience",
  bonds: "experience",
  players: "experience",
  board: "experience",
  variants: "experience",
  voiceChat: "experience",
};

export type GroupControl = {
  isOpen: (id: GroupId) => boolean;
  setOpen: (id: GroupId, open: boolean) => void;
};

// What a DetailGroup needs from the dialog for one group.
export function groupProps(groups: GroupControl, id: GroupId) {
  return { id, open: groups.isOpen(id), onToggle: (open: boolean) => groups.setOpen(id, open) };
}

# Illegal Character States: Reconciliation Policy

Status: design approved 2026-10-17. Implementation follows.

## Problem

Character sheets will be illegal, often. Three distinct causes, one bucket in the
data:

1. **Legacy writer bugs** — old code stored wrong shapes (name-spelled entries
   like `nature` instead of `nat`, silently dropped feat grants like Techie's
   Technology). Maurice's sheet has both.
2. **Homebrew / DM fiat** — an entry that no pack row can produce, by design.
3. **Jammed picks** — the system got in the way, so the user poked the sheet
   directly to force an outcome.

Rendering already tolerates all three (read-side `resolveSkillEntry`). The gap
is *policy*: what happens to these states over time — at import, and on demand
against stored sheets.

## Policy

- **The legality gate stays binary** (matches ODM upstream
  `POST /api/characters/import`: full 201 create or full refusal, nothing
  written). Reconciliation is never a partial landing.
- **Reconciliation runs before the gate** as a pre-shaping pass, and standalone
  on stored sheets, on demand. It is two stages:

### Stage 1 — deterministic reconcile (`reconcile-sheet`)

Input: a sheet (bundled file, imported bundle, or stored character id). No LLM
anywhere in this stage.

Computes the *expected grant set* from the sheet's own choices (class,
subclass, background, `asiChoices` feats, racial picks) — nothing guessed.
Performs only provable operations:

- **canonicalize** — legacy spellings → pack ids via `resolveSkillEntry`
  (`nature` → `nat`).
- **apply missing grant** — a chosen feat whose pack grant is provably absent
  from the stored list (Techie → `tec`): write the id. Writes directly:
  deterministic and reversible.
- **flag** — anything ambiguous (orphan picks, skills whose only candidate
  grant comes from a feat the sheet does not have, unresolvable entries):
  untouched, emitted as a warning with evidence.

Output: a JSON log with a per-entry outcome — `success` / `partial` /
`failure` — plus warnings, and a process exit code (nonzero on any failure).
Idempotent: a second run on a fixed sheet is a no-op. The log is the only
thing Stage 2 sees.

### Stage 2 — agent intent pass (no code: the agent IS stage 2)

Stage 2 is performed by the assistant in conversation, not by an in-app
component. Input is *only* the Stage 1 log plus character context (classes,
feats, background) — never the raw sheet. For each flagged entry:

1. Hypothesize the legal mechanism that produces the observed state.
2. Verify against the pack: the feat/feature exists, prerequisites hold.
3. Propose to the authority holder: mint the grant, convert to an explicit
   **house-grant**, or recommend removal.

**Writes are gated on approval from the sheet's authority holder** — the GM,
who in ODM can also be the player. Same authority precedent as story-content
import (`src/lib/db/import-sources.ts`: story authority = party lead in an
AI-run game, the DM once a person runs it).

Accepted proposals that map to a real feature are written as that feature.
Accepted proposals that map to nothing become **explicit house-grant
features** — traceable, visible on the sheet, deletable.

### Relation to import

Today's import is the offline FVTT converter
(`scripts/oc-fvtt-convert.py`): it already does a proto-reconciliation
distribution pass and drops unmappable skills with a warning. The future
in-game import feature keeps ODM's binary door and calls reconciliation as a
pre-pass:

```
bundle → reconcile-sheet (Stage 1) → [agent pass if warnings] → admit gate → create or refuse
```

A refused import carries the reconcile log alongside the legality problems, so
the user sees both what the gate rejected and what the pre-pass already fixed
or needs a decision on.

## Scope of first implementation

- `scripts/reconcile-sheet.mjs`: skills first (the proven pain point). Saves,
  tools, and languages follow the same shape once proven.
- Log schema under `scripts/reconcile/`, designed for agent consumption:
  self-contained (the agent sees the log alone), with evidence per warning.
- Wiring: run Stage 1 automatically at the end of `oc-fvtt-convert.py`;
  standalone mode for stored characters.
- Tests: idempotency, Maurice's sheet as fixture (canonicalize + missing
  grant), orphan-flagging, exit codes.

// Stage 1 of the sheet reconciliation policy (docs/reconciliation-policy.md):
// the deterministic, idempotent reconcile of a character sheet's skill
// proficiencies. Pure: no database, no filesystem — the CLI wrapper
// (scripts/reconcile-sheet.mjs) mounts the content pack, loads the sheet and
// hands in the providers; the tests (scripts/test-reconcile-sheet.mjs) hand
// in synthetic ones.
//
// It computes the sheet's EXPECTED skill grants from the sheet's own recorded
// choices — race picks, feat picks (featChoices keyed by each feat on the
// sheet), and the fixed skills a feat's text grants — and performs only
// provable operations:
//
//   canonicalize        a legacy spelling or display name ("Nature") that
//                       resolves to an active skill whose id differs
//                       ("nat") is rewritten in place
//   apply-missing-grant a provable grant (racial pick, feat pick, feat's
//                       fixed skills) absent from the held list is written
//   flag                everything ambiguous is untouched and emitted as a
//                       warning with evidence — orphan skills (no recorded
//                       source offers them), unresolvable entries (nothing
//                       in the active skill set answers to them), feats the
//                       catalog does not know (their picks prove nothing)
//
// Offers (the class's skill list, the background's skills) are NOT provable
// grants: a legal sheet may decline any offer. They serve only as evidence
// that an already-held skill has a recorded source.
//
// Per-entry outcomes are success / partial / failure; the summary's `result`
// is failure when any entry failed, partial when only warnings fired, and
// success otherwise. The log is the only thing Stage 2 (the agent, in
// conversation) sees, so every entry carries its evidence.

// One reconcile of the skills list. Providers:
//   resolveEntry(entry) -> { id, name } | null
//       the active skill set's answer to a stored entry, by id or
//       case-insensitive name (src/lib/content/skills.ts resolveSkillEntry)
//   classOffers / backgroundSkills: string[]
//       skills the sheet's class and background offer (evidence only)
//   racialSkills: string[]  provable grants from racialChoices.skills
//   feats: Array<{ name, desc?, spec?, picks? }>
//       each feat on the sheet: its catalog text (desc) or a pre-read
//       FeatGrantSpec, plus the sheet's featChoices picks for it
export function reconcileSheetSkills(sheet, providers) {
  const proficiencies = sheet.proficiencies ?? { skills: [], languages: [], weapons: [], tools: [], armor: [] };
  const held = [...(proficiencies.skills ?? [])];
  const ops = [];
  const warnings = [];
  const failures = [];
  const resolveEntry = providers.resolveEntry ?? (() => null);

  const offers = [...(providers.classOffers ?? []), ...(providers.backgroundSkills ?? [])]
    .map((entry) => resolveEntry(entry)?.id ?? entry.trim().toLowerCase())
    .filter(Boolean);
  const offered = (id) => offers.includes(id);

  // The provable grants, each with the choice that proves it.
  const provable = [];
  for (const skill of providers.racialSkills ?? []) {
    const entry = resolveEntry(skill);
    if (entry) {
      provable.push({ id: entry.id, because: `racial choice "${skill}"` });
    }
  }
  for (const feat of providers.feats ?? []) {
    const spec = feat.spec ?? null;
    const picks = feat.picks ?? {};
    const because = (what) => `${feat.name} ${what}`;
    if (!spec) {
      warnings.push({
        code: "feat-not-in-catalog",
        entry: feat.name,
        outcome: "flagged",
        evidence:
          `no catalog row answers to feat "${feat.name}"; its recorded picks ` +
          `[${(picks.skills ?? []).join(", ") || "none"}] prove nothing and were left alone.`,
      });
      continue;
    }
    for (const skill of spec.fixedSkills ?? []) {
      const entry = resolveEntry(skill);
      if (entry) {
        provable.push({ id: entry.id, because: because(`grants the ${entry.name} skill outright`) });
      }
    }
    for (const skill of picks.skills ?? []) {
      const entry = resolveEntry(skill);
      // A pick outside the feat's offer is legality's complaint, not this
      // stage's: the pick was recorded, which is proof enough of intent.
      if (entry) {
        provable.push({ id: entry.id, because: because(`pick "${skill}"`) });
      } else {
        warnings.push({
          code: "unresolvable-pick",
          entry: `${feat.name} → ${skill}`,
          outcome: "flagged",
          evidence: `feat "${feat.name}" has a recorded skill pick "${skill}" that no active skill answers to.`,
        });
      }
    }
  }

  // --- canonicalize: every held entry that resolves to a different id.
  const canonical = [];
  for (const entry of held) {
    const resolved = resolveEntry(entry);
    if (!resolved) {
      canonical.push(entry);
      failures.push({
        code: "unresolvable-skill",
        entry,
        outcome: "failure",
        evidence: `no active skill answers to "${entry}" (id or name); it was left as stored.`,
      });
      continue;
    }
    if (resolved.id !== entry) {
      ops.push({
        op: "canonicalize",
        field: "proficiencies.skills",
        from: entry,
        to: resolved.id,
        because: `"${entry}" resolves by name to the active skill ${resolved.name} (${resolved.id}).`,
        outcome: "success",
      });
    }
    if (!canonical.some((existing) => (resolveEntry(existing)?.id ?? existing) === resolved.id)) {
      canonical.push(resolved.id);
    }
  }

  // --- apply-missing-grant: each provable grant the list lacks.
  const heldIds = () => new Set(canonical.map((entry) => resolveEntry(entry)?.id ?? entry));
  for (const grant of provable) {
    if (heldIds().has(grant.id)) {
      continue;
    }
    canonical.push(grant.id);
    ops.push({
      op: "apply-missing-grant",
      field: "proficiencies.skills",
      to: grant.id,
      because: `${grant.because}, and the held list lacked it.`,
      outcome: "success",
    });
  }

  // --- flag: held skills with no recorded source anywhere (an entry already
  // reported unresolvable is not flagged twice).
  const unresolvable = new Set(failures.map((failure) => failure.entry));
  const provableIds = new Set(provable.map((grant) => grant.id));
  for (const id of heldIds()) {
    if (unresolvable.has(id) || provableIds.has(id) || offered(id)) {
      continue;
    }
    const name = resolveEntry(id)?.name ?? id;
    warnings.push({
      code: "orphan-skill",
      entry: id,
      outcome: "flagged",
      evidence:
        `"${name}" (${id}) is held but nothing recorded on the sheet produces it: ` +
        `not a racial pick, not a feat pick or fixed grant, not in the class's or background's offer lists.`,
    });
  }

  canonical.sort();
  const skills = canonical;
  const sheetOut = { ...sheet, proficiencies: { ...proficiencies, skills } };

  const success = ops.filter((op) => op.outcome === "success").length;
  const summary = {
    applied: success,
    success,
    partial: warnings.length,
    failure: failures.length,
    result: failures.length ? "failure" : warnings.length ? "partial" : "success",
  };
  return { sheet: sheetOut, ops, warnings, failures, summary };
}

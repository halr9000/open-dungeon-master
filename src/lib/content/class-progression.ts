// A content pack's class progression, as the pure grant helpers see it.
//
// The pack's class_progression table carries a class's level-by-level
// features and grants (the SW5e pack is the first writer). Reading it needs
// the content database (src/lib/content/db.ts), which lives server-side only;
// the readers here are registered data, so the client-side derivation (the
// builder, the level-up dialog) consults it without touching a database.
// A pack without the table — every Open5e pack today — registers nothing,
// and the bundled tables answer as they always have.

// One base-class feature row: the level it arrives at and its name. A
// class's archetypes carry their own rows (archetype_slug set) and ride the
// subclass tables, not this one.
export type PackClassFeature = {
  level: number;
  name: string;
};

const PACK_CLASS_FEATURES: Record<string, PackClassFeature[]> = {};

export function registerPackClassFeatures(slug: string, features: PackClassFeature[]): void {
  PACK_CLASS_FEATURES[slug.trim().toLowerCase()] = [...features];
}

// A pack class's features, in level order. Empty for every class the pack
// does not describe.
export function packClassFeaturesFor(slug: string): PackClassFeature[] {
  return PACK_CLASS_FEATURES[slug.trim().toLowerCase()] ?? [];
}

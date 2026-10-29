// The name dice beside the builder's name field: one tap rolls a name that
// fits the chosen lineage, or any lineage before one is chosen. A world pack's
// own people's names come first when it has them. The lists are ODM's own,
// written for this; given names lean neutral so the roll never decides who
// the character is.
import { lineageFamily } from "./lineage";

type Names = { given: string[]; family: string[] };

const HUMAN: Names = {
  given: ["Rowan", "Ash", "Morgan", "Sable", "Quinn", "Ellis", "Tamsin", "Corin", "Hollis", "Wren", "Bram", "Isa", "Merrit", "Joss"],
  family: ["Ashvale", "Marrow", "Thornfield", "Greaves", "Hollowell", "Brightwater", "Dunmore", "Keel", "Fairwind", "Coldbrook"],
};
const ELF: Names = {
  given: ["Aerin", "Ilyra", "Faen", "Sylvar", "Liran", "Eryndel", "Thaelis", "Naeva", "Caelith", "Seren"],
  family: ["Moonbrook", "Silverleaf", "Duskwhisper", "Starwind", "Amberfall", "Dawnmere"],
};

const NAMES: Record<string, Names> = {
  human: HUMAN,
  elf: ELF,
  "half-elf": { given: [...HUMAN.given.slice(0, 7), ...ELF.given.slice(0, 5)], family: [...HUMAN.family.slice(0, 5), ...ELF.family.slice(0, 3)] },
  dwarf: {
    given: ["Brann", "Sigra", "Torvik", "Runa", "Ottmar", "Ketta", "Haldor", "Hild", "Grima", "Durn"],
    family: ["Stoutheart", "Ironfoot", "Gravelbeard", "Deepdelve", "Hammerfall", "Coppervein", "Stonemantle"],
  },
  halfling: {
    given: ["Pip", "Rosie", "Tobin", "Cade", "Milo", "Poppy", "Fen", "Bramble", "Nell", "Tuck"],
    family: ["Applewhistle", "Hearthkettle", "Mossbottom", "Copperpot", "Tumblebrook", "Butterbank"],
  },
  gnome: {
    given: ["Fizz", "Nim", "Bimble", "Tink", "Quillon", "Zook", "Dabble", "Orrin", "Pell", "Wix"],
    family: ["Cogsworth", "Gearwhistle", "Sparkletop", "Tinkerton", "Brassbuckle", "Fiddlespring"],
  },
  "half-orc": {
    given: ["Draka", "Murga", "Rusk", "Varga", "Krull", "Sharn", "Ogra", "Gash", "Torka", "Brugg"],
    family: ["Bonecutter", "Ashtusk", "Ironjaw", "Redhand", "Stonebrow", "Grimhollow"],
  },
  dragonborn: {
    given: ["Vyrrath", "Kesh", "Thravik", "Sorrix", "Balaxa", "Rhazul", "Ixen", "Zaveth", "Quarrin", "Sulra"],
    family: ["Ashscale", "Embercrest", "Vorrathi", "Stormclaw", "Kaldrex", "Brightfang"],
  },
  tiefling: {
    given: ["Ember", "Vesper", "Nyx", "Caius", "Mordai", "Riven", "Solace", "Hex", "Lament", "Sorrow"],
    family: ["Ashvale", "Marrow", "Greaves", "Coldbrook", "Duskwhisper"],
  },
};

const pick = <T>(list: readonly T[], rng: () => number): T => list[Math.floor(rng() * list.length) % list.length];

// A name for the lineage chosen so far (none yet: any lineage's), never the
// one the field already holds when there is another to give.
export function rollHeroName({
  raceId = "",
  raceName = "",
  packNames = [],
  current = "",
  rng = Math.random,
}: {
  raceId?: string;
  raceName?: string;
  packNames?: string[];
  current?: string;
  rng?: () => number;
}): string {
  const now = current.trim();
  if (packNames.length) {
    // Drawn from the names that are not already in the field, so a pack of
    // two always gives the other.
    const others = packNames.filter((name) => name !== now);
    return pick(others.length ? others : packNames, rng);
  }
  const family = raceId || raceName ? lineageFamily(raceId, raceName) : null;
  const names = (family && NAMES[family]) || pick(Object.values(NAMES), rng);
  const name = `${pick(names.given, rng)} ${pick(names.family, rng)}`;
  if (name !== now) {
    return name;
  }
  // The same pair twice: keep the family, take the next given name.
  const next = names.given[(names.given.indexOf(name.split(" ")[0]) + 1) % names.given.length];
  return `${next} ${name.split(" ").slice(1).join(" ")}`;
}

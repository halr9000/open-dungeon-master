// A title to start from, for someone who would rather name the campaign once
// they know what it is: the dice beside the title field roll one in the
// genre's own words. Always editable, never required to be kept. Pure, for
// scripts/test-campaign-creator-flow.mjs.

type Bank = { things: string[]; places: string[]; marks: string[] };

const FANTASY: Bank = {
  things: ["Crown", "Oath", "Throne", "Ember", "Blade", "Hollow", "Tide", "Song", "Wyrm", "Lantern"],
  places: ["the Ash Kingdom", "Greywater", "the Sunken Keep", "Thornhold", "the Silver March", "Vael", "the Old Road", "Emberfall"],
  marks: ["Last", "Broken", "Hidden", "Forgotten", "Burning", "Silent", "Shattered"],
};

const BANKS: Record<string, Bank> = {
  high_fantasy: FANTASY,
  dark_fantasy: {
    things: ["Rot", "Hunger", "Pyre", "Bell", "Crown", "Wound", "Veil", "Grave"],
    places: ["the Blighted Vale", "Ravensmoor", "the Ashen Abbey", "Morrow's End", "the Drowned Choir"],
    marks: ["Black", "Weeping", "Hollow", "Bleeding", "Last", "Pale"],
  },
  mystery: {
    things: ["Letter", "Key", "Locket", "Ledger", "Portrait", "Clock", "Masquerade", "Will"],
    places: ["Blackwood Manor", "Harrow Street", "the Gilded Theatre", "Fenwick Hall", "the Night Train"],
    marks: ["Missing", "Thirteenth", "Silent", "Crimson", "Final", "Stolen"],
  },
  horror: {
    things: ["Hunger", "Whisper", "Bell", "Dark", "Door", "Lullaby", "Visitor", "Harvest"],
    places: ["Hollow Creek", "the Asylum", "Saltmarsh", "the Lighthouse", "Widow's Rest"],
    marks: ["Endless", "Drowned", "Crawling", "Quiet", "Last", "Pale"],
  },
  cyberpunk: {
    things: ["Signal", "Ghost", "Protocol", "Static", "Contract", "Circuit", "Glitch", "Neon"],
    places: ["Sector Nine", "the Undercity", "Kowloon Stack", "the Glass Spire", "Night Market"],
    marks: ["Dead", "Chrome", "Broken", "Black", "Zero", "Hollow"],
  },
  steampunk: {
    things: ["Engine", "Gear", "Airship", "Clockwork", "Furnace", "Compass", "Expedition", "Patent"],
    places: ["Brasshaven", "the Iron Quarter", "the Cloud Docks", "Gearmouth", "the Copper Line"],
    marks: ["Brass", "Final", "Lost", "Silent", "Clockwork", "Gilded"],
  },
  post_apocalyptic: {
    things: ["Wasteland", "Signal", "Convoy", "Water", "Fallout", "Radio", "Bunker", "Dust"],
    places: ["the Dry Sea", "Route 66", "the Glass Desert", "Rust Town", "the Dead Zone"],
    marks: ["Last", "Burning", "Lost", "Rusted", "Silent", "Final"],
  },
};

const pickOne = <T,>(list: T[], random: () => number) => list[Math.floor(random() * list.length) % list.length];

export function rollCampaignTitle(genre: string, current = "", random: () => number = Math.random): string {
  const bank = BANKS[genre] ?? FANTASY;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const shape = Math.floor(random() * 3);
    const title =
      shape === 0
        ? `The ${pickOne(bank.marks, random)} ${pickOne(bank.things, random)}`
        : shape === 1
          ? `${pickOne(bank.things, random)} of ${pickOne(bank.places, random)}`
          : `The ${pickOne(bank.marks, random)} ${pickOne(bank.things, random)} of ${pickOne(bank.places, random)}`;
    if (title !== current) return title;
  }
  return `The ${pickOne(bank.things, random)} of ${pickOne(bank.places, random)}`;
}

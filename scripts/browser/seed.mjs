// The world the browser scenarios open: one table in a fight on a painted
// board with a full chronicle, one campaign still in its lobby, and a lead
// with a password. Writes the database, its key and the ids the scenarios
// need into the folder given, then exits (enforce-world cleans its own
// scratch folder on the way out).
//
//   node scripts/browser/seed.mjs <out-dir>
import fs from "node:fs";
import path from "node:path";
import { openWorld } from "../lib/enforce-world.mjs";
import { combatKit } from "../lib/enforce-combat.mjs";

const out = process.argv[2];
if (!out) {
  throw new Error("seed.mjs needs the folder to write into");
}
fs.mkdirSync(out, { recursive: true });

const PASSWORD = "Browser-2026-pass";
const TITLE = "Regression Table";
const LOBBY_TITLE = "Regression Lobby";

const world = await openWorld({ campaign: { title: TITLE }, gameSettings: { ttsEnabled: true } });
const kit = await combatKit(world);
const { getDatabase } = await import("../../src/lib/db/core.ts");
const campaigns = await import("../../src/lib/db/campaigns.ts");
const messages = await import("../../src/lib/db/messages.ts");
const { setUserPassword } = await import("../../src/lib/db/users.ts");
const { hashPassword } = await import("../../src/lib/auth.ts");
const { LEAD_NOTE_PREFIX } = await import("../../src/lib/campaign-types.ts");

const tavi = world.addHero({
  user: world.owner,
  name: "Tavi Lockwhisper",
  class: "rogue",
  level: 3,
  abilities: { str: 10, dex: 16 },
  proficiencies: { saves: ["dex", "int"], skills: ["stealth"], expertise: [], languages: ["Common"], tools: [], armor: ["light"], weapons: ["simple", "martial"] },
  equipment: [
    { name: "Rapier", qty: 1, equipped: true },
    { name: "Dagger", qty: 2, equipped: true },
    { name: "Leather", qty: 1, equipped: true },
  ],
});

// The story so far, enough to fill the chronicle's window, ending on the
// two entries the chronicle scenario reads whole: a long system line (a
// lead's direction, the prefix the transcript draws as a card) and a
// three-paragraph passage with emphasis and a question at its end.
const say = (content, extra = {}) => {
  const seq = campaigns.allocateSeq(world.campaignId);
  return messages.insertCampaignMessage({ campaignId: world.campaignId, seq, ...extra, content });
};
for (let index = 1; index <= 44; index += 1) {
  if (index % 3 === 0) {
    say(`Line ${index}: Tavi keeps low and watches the door.`, { authorType: "player", userId: world.owner.id, characterId: tavi.id });
  } else {
    say(`Passage ${index}. The rain drums on the slate roof of the old mill while the goblins argue in the yard below. Lantern light spills across the wet stones, and somewhere a chain rattles against a post as the wind turns.`, { authorType: "dm", speech: [] });
  }
}
const systemLine =
  "Keep to the shadows along the east wall, wait for the second goblin to turn his back, and only then go for the lantern. If the dog wakes, we scatter and meet at the ford before dawn.";
say(`${LEAD_NOTE_PREFIX}${systemLine}`, { authorType: "system" });
const paragraphs = [
  "The *bolt* dies against wet salt and the yard goes quiet, the kind of quiet that has teeth in it.",
  "The nearer goblin lowers his torch. His eyes find the shadow you are standing in and stay there a moment too long.",
  "_What_ do you do?",
];
say(paragraphs.join("\n\n"), { authorType: "dm", speech: [] });

await kit.fight(1, { heroFaces: { [tavi.id]: 19 } });
const [goblin] = world.enemies();
kit.place(tavi.id, 2, 2);
kit.place(goblin.id, 3, 2);
kit.giveTurn(tavi.id);

// A campaign still in its lobby, for the lobby pages and the cover dialog.
const lobby = campaigns.createCampaign(world.owner.id, {
  title: LOBBY_TITLE,
  description: "A table that has not started.",
  theme: "high-fantasy",
  maxPlayers: 6,
  startingLevel: 1,
  difficulty: "normal",
  gameSettings: { ttsEnabled: false },
});

const player = world.addUser("player");
for (const user of [world.owner, player]) {
  setUserPassword(user.id, await hashPassword(PASSWORD), false);
}

const ids = {
  lead: world.owner.username,
  player: player.username,
  password: PASSWORD,
  title: TITLE,
  lobbyTitle: LOBBY_TITLE,
  campaignId: world.campaignId,
  lobbyId: lobby.id,
  tavi: tavi.id,
  goblin: goblin.id,
  systemLine,
  paragraphs: paragraphs.map((text) => text.replace(/[*_]/g, "")),
};
getDatabase().pragma("wal_checkpoint(TRUNCATE)");
fs.copyFileSync(process.env.SQLITE_DB_PATH, path.join(out, "world.sqlite"));
fs.writeFileSync(path.join(out, "key"), process.env.DB_ENCRYPTION_KEY);
fs.writeFileSync(path.join(out, "ids.json"), JSON.stringify(ids, null, 2));
getDatabase().close();
console.log(`seeded ${TITLE} (${world.campaignId}) and ${LOBBY_TITLE} (${lobby.id}) into ${out}`);

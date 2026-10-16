// Personal campaign defaults (src/lib/campaign-defaults.ts, the creator's
// src/app/create-campaign/defaults.ts and /api/profile/campaign-defaults):
// what is saved and what never is, how a stored setup is read back, how it
// is laid over a draft without touching the campaign's own fields, and that
// each account reads only its own.
import assert from "node:assert/strict";
import { openWorld } from "./lib/enforce-world.mjs";
import { suite } from "./lib/enforce-harness.mjs";

const { test, finish } = suite("test-campaign-defaults");

const { CAMPAIGN_DEFAULT_KEYS, DEFAULT_GAME_SETTING_KEYS, readStoredDefaults, validateDefaultsWrite } = await import(
  "../src/lib/campaign-defaults.ts"
);
const { DEFAULT_DRAFT } = await import("../src/app/create-campaign/draft.ts");
const { appDefaultSettings, applyDefaults, defaultsFromDraft } = await import("../src/app/create-campaign/defaults.ts");
const { gameSettingsSchema } = await import("../src/lib/schemas/game-settings.ts");
const { getUserSettings, updateUserSettings } = await import("../src/lib/db/users.ts");

const pristine = structuredClone(DEFAULT_DRAFT);

// A draft with a choice in every corner a careless copy would lose: false,
// 0-like values, empty and full lists, null, nested objects.
const chosen = {
  ...structuredClone(DEFAULT_DRAFT),
  title: "The Ashen Crown",
  description: "A crown nobody should wear.",
  theme: "Grim court intrigue",
  themeTouched: true,
  descriptionTouched: true,
  worldPack: "",
  dmMode: "steered",
  genre: "dark_fantasy",
  customGenreText: "  ",
  maxPlayers: 3,
  startingLevel: 4,
  difficulty: "hard",
  ttsEnabled: false,
  ttsVoice: "bm_fable",
  ttsSpeed: 1.25,
  ttsAutoCast: true,
  mapsEnabled: false,
  abilityRerollBelow: null,
  safety: { xCard: false, lines: ["spiders"], veils: [], boundaries: "mature" },
  gm: { strictness: "harsh", tone: ["grim", "eerie"] },
  relationships: "off",
  romance: "off",
  variantRules: { ...DEFAULT_DRAFT.variantRules, flanking: true, restVariant: "gritty" },
  companions: "guests",
  maxGuests: 4,
  voiceChat: { ...DEFAULT_DRAFT.voiceChat, enabled: false, rules: { ...DEFAULT_DRAFT.voiceChat.rules, proximity: true, hearingRangeFeet: 60 } },
  houseRules: "Potions:\nDrinking one is a bonus action.",
  loreDrafts: [{ category: "history", title: "The Sundering", body: "It broke the sky." }],
  contentImport: { ...DEFAULT_DRAFT.contentImport, sourceId: "ws-1", select: ["npcs"] },
  storySetupKept: true,
};

await test("a draft saves only table settings, never the campaign's own fields or the editor's bookkeeping", () => {
  const saved = defaultsFromDraft(chosen);
  for (const key of ["title", "description", "theme", "worldPack", "loreDrafts", "contentImport", "themeTouched", "descriptionTouched", "storySetupKept", "voiceChat"]) {
    assert.ok(!(key in saved), `${key} was saved`);
  }
  assert.deepEqual(saved.voice, chosen.voiceChat, "live voice chat is saved under its gameSettings name");
  assert.equal(saved.customGenreText, "", "trimmed as the campaign would be");
  assert.deepEqual(Object.keys(saved).sort(), [...CAMPAIGN_DEFAULT_KEYS].sort(), "every allowed key, and only those");
  assert.ok(
    DEFAULT_GAME_SETTING_KEYS.every((key) => key in gameSettingsSchema.shape),
    "every saved game setting is one a campaign has",
  );
});

await test("false, null, empty lists and nested choices survive a save and a load", () => {
  const checked = validateDefaultsWrite({ version: 1, settings: defaultsFromDraft(chosen) });
  assert.equal(checked.ok, true, checked.error);
  const { draft } = applyDefaults(structuredClone(DEFAULT_DRAFT), checked.settings, null);
  for (const key of ["dmMode", "genre", "maxPlayers", "startingLevel", "difficulty", "ttsEnabled", "ttsVoice", "ttsSpeed", "ttsAutoCast", "mapsEnabled", "abilityRerollBelow", "safety", "gm", "relationships", "romance", "variantRules", "companions", "maxGuests", "voiceChat", "houseRules"]) {
    assert.deepEqual(draft[key], chosen[key], key);
  }
});

await test("a write is all known keys with values a campaign accepts, or nothing", () => {
  const settings = defaultsFromDraft(DEFAULT_DRAFT);
  assert.equal(validateDefaultsWrite({ version: 1, settings }).ok, true);
  assert.equal(validateDefaultsWrite({ version: 2, settings }).ok, false, "an unknown version");
  assert.equal(validateDefaultsWrite({ settings }).ok, false, "no version");
  assert.equal(validateDefaultsWrite({ version: 1, settings, extra: 1 }).ok, false, "an extra top-level key");
  assert.equal(validateDefaultsWrite({ version: 1, settings: { ...settings, title: "Mine" } }).ok, false, "a campaign's own field");
  assert.equal(validateDefaultsWrite({ version: 1, settings: { ...settings, openAiKey: "sk-x" } }).ok, false, "a credential-shaped key");
  assert.equal(validateDefaultsWrite({ version: 1, settings: { ...settings, maxPlayers: 9 } }).ok, false, "a party of nine");
  assert.equal(validateDefaultsWrite({ version: 1, settings: { ...settings, ttsSpeed: 3 } }).ok, false, "a pace out of range");
  assert.equal(validateDefaultsWrite({ version: 1, settings: { ...settings, gm: { strictness: "cruel", tone: [] } } }).ok, false, "an unknown strictness");
  assert.equal(validateDefaultsWrite({ version: 1, settings: { ...settings, houseRules: "x".repeat(20_001) } }).ok, false, "house rules past the cap");
  assert.equal(validateDefaultsWrite({ version: 1, settings: {} }).ok, true, "an empty set is a valid (if pointless) save");
  assert.equal(validateDefaultsWrite(null).ok, false);
});

await test("a stored setup is read back key by key: a bad or retired value is dropped, the rest still apply", () => {
  const read = readStoredDefaults({
    version: 7,
    savedAt: "2026-10-14T00:00:00.000Z",
    settings: { genre: "nonexistent", maxPlayers: 3, ttsAutoCast: false, retired: true, abilityRerollBelow: null },
  });
  assert.deepEqual(read.settings, { maxPlayers: 3, ttsAutoCast: false, abilityRerollBelow: null });
  assert.equal(read.savedAt, "2026-10-14T00:00:00.000Z");
  assert.equal(readStoredDefaults({ settings: { genre: "nonexistent" } }), null, "nothing usable");
  assert.equal(readStoredDefaults("garbage"), null);
  assert.equal(readStoredDefaults(undefined), null);
  // A missing key stays missing: the schema's default is not slipped in.
  assert.deepEqual(Object.keys(readStoredDefaults({ settings: { difficulty: "easy" } }).settings), ["difficulty"]);
});

await test("applying defaults leaves the campaign's own fields, and never reaches back into what it was given", () => {
  const draft = { ...structuredClone(DEFAULT_DRAFT), title: "Mine", description: "My premise", theme: "My theme", themeTouched: true, descriptionTouched: true };
  const settings = defaultsFromDraft(chosen);
  const { draft: next } = applyDefaults(draft, settings, null);
  assert.equal(next.title, "Mine");
  assert.equal(next.description, "My premise");
  assert.equal(next.theme, "My theme", "a typed theme is not rewritten");
  next.safety.lines.push("snakes");
  next.variantRules.flanking = false;
  assert.deepEqual(settings.safety.lines, ["spiders"], "the saved setup was shared with the draft");
  assert.equal(settings.variantRules.flanking, true);
  assert.deepEqual(DEFAULT_DRAFT, pristine, "DEFAULT_DRAFT was changed");
});

await test("an untouched theme follows the saved genre; a chosen world pack keeps its own setting and says so", () => {
  const fresh = structuredClone(DEFAULT_DRAFT);
  const { draft } = applyDefaults(fresh, { genre: "dark_fantasy" }, null);
  assert.equal(draft.genre, "dark_fantasy");
  assert.notEqual(draft.theme, fresh.theme, "the preset's theme was not written");
  const withPack = { ...structuredClone(DEFAULT_DRAFT), worldPack: "saltmarch", genre: "high_fantasy", theme: "Salt and smoke" };
  const pack = { id: "saltmarch", name: "The Saltmarch" };
  const applied = applyDefaults(withPack, { genre: "dark_fantasy", maxPlayers: 2 }, pack);
  assert.equal(applied.draft.genre, "high_fantasy", "a saved genre was blended over a pack");
  assert.equal(applied.draft.worldPack, "saltmarch");
  assert.equal(applied.draft.theme, "Salt and smoke");
  assert.equal(applied.draft.maxPlayers, 2, "the rest still applies");
  assert.match(applied.kept.join(" "), /The Saltmarch keeps its own setting/);
});

await test("saved defaults never switch on transcription", () => {
  const voice = { ...DEFAULT_DRAFT.voiceChat, transcribe: true };
  const { draft } = applyDefaults(structuredClone(DEFAULT_DRAFT), { voice }, null);
  assert.equal(draft.voiceChat.transcribe, false);
});

await test("the Storyboard warning is asked again when defaults change AI story setup", () => {
  const draft = { ...structuredClone(DEFAULT_DRAFT), aiStorySetup: false, storySetupKept: true };
  assert.equal(applyDefaults(draft, { aiStorySetup: true }, null).draft.storySetupKept, false);
  assert.equal(applyDefaults(draft, { aiStorySetup: false }, null).draft.storySetupKept, true);
});

await test("the app's defaults are DEFAULT_DRAFT's settings", () => {
  const { draft } = applyDefaults(chosen, appDefaultSettings(), null);
  for (const key of ["dmMode", "ttsAutoCast", "safety", "variantRules", "voiceChat", "houseRules", "maxPlayers"]) {
    assert.deepEqual(draft[key], DEFAULT_DRAFT[key], key);
  }
  assert.equal(draft.title, chosen.title);
  assert.deepEqual(draft.loreDrafts, chosen.loreDrafts, "lore is the campaign's own");
});

const world = await openWorld();
const route = await world.route("profile/campaign-defaults");
const profile = await world.route("profile");
const call = async (handler, user, body) => {
  if (user) {
    world.signIn(user);
  } else {
    globalThis.__odmTestToken = undefined;
  }
  const response = await handler(
    new Request("http://test/", body === undefined ? {} : { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
  return { status: response.status, body: await response.json() };
};

await test("an account saves, reads and removes its own defaults; another account sees none of them", async () => {
  const owner = world.owner;
  const other = world.addUser("other");
  updateUserSettings(owner.id, { narrationVolume: 0.4, diceLook: undefined });
  assert.deepEqual((await call(route.GET, owner)).body, { defaults: null });
  const settings = defaultsFromDraft(chosen);
  const saved = await call(route.PUT, owner, { version: 1, settings });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual((await call(route.GET, owner)).body.defaults.settings, settings);
  assert.deepEqual((await call(route.GET, other)).body, { defaults: null }, "another account read them");
  assert.equal(getUserSettings(owner.id).narrationVolume, 0.4, "saving defaults dropped an audio preference");
  // The profile's own PATCH cannot write them, and leaves them alone.
  await call((request) => profile.PATCH(new Request(request.url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: { chimeMuted: true, campaignDefaults: { version: 1, settings: { maxPlayers: 1 } } } }) })), owner);
  assert.deepEqual((await call(route.GET, owner)).body.defaults.settings, settings, "the profile PATCH reached the defaults");
  const removed = await call(route.DELETE, owner);
  assert.deepEqual(removed.body, { defaults: null });
  assert.deepEqual((await call(route.GET, owner)).body, { defaults: null });
  assert.equal(getUserSettings(owner.id).narrationVolume, 0.4, "removing defaults dropped an audio preference");
  assert.equal(getUserSettings(owner.id).chimeMuted, true);
});

await test("a refused save says why and keeps what was there", async () => {
  const owner = world.owner;
  await call(route.PUT, owner, { version: 1, settings: { maxPlayers: 2 } });
  const refused = await call(route.PUT, owner, { version: 1, settings: { maxPlayers: 2, title: "nope" } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /title/);
  assert.deepEqual((await call(route.GET, owner)).body.defaults.settings, { maxPlayers: 2 });
});

await test("nobody signed in gets nothing", async () => {
  assert.equal((await call(route.GET, null)).status, 401);
  assert.equal((await call(route.PUT, null, { version: 1, settings: {} })).status, 401);
  assert.equal((await call(route.DELETE, null)).status, 401);
});

world.close();
finish();

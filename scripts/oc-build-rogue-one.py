#!/usr/bin/env python3
"""Build the Rogue One campaign + party on the SW5e POC instance (:3210).

Admin token must exist at /tmp/odm-sw5e-token.txt. Registers 5 member
accounts (passwords to /tmp/sw5e-party-creds.json, 0600), joins them via the
campaign invite code, creates one library character per member, sets each
member's active_character_id directly in the POC DB, and posts campaign lore.
"""
import json
import os
import secrets
import time
import urllib.request
import urllib.error

BASE = "http://neo.home:3210"
POC_DB = "/home/halr9000/projects/odm-sw5e/data/sw5e-app.sqlite"
POC_KEY = open("/home/halr9000/projects/odm-sw5e/.env.server").read()
KEY = [l.split("=", 1)[1].strip() for l in POC_KEY.splitlines() if l.startswith("DB_ENCRYPTION_KEY=")][0]


def call(path, method="GET", body=None, tok=None):
    headers = {"Content-Type": "application/json"}
    if tok:
        headers["Authorization"] = "Bearer " + tok
    r = urllib.request.Request(BASE + path, method=method,
                               data=json.dumps(body).encode() if body else None, headers=headers)
    try:
        return json.load(urllib.request.urlopen(r, timeout=30)), None
    except urllib.error.HTTPError as e:
        return None, {"code": e.code, "body": e.read()[:300].decode(errors="replace")}


admin = open("/tmp/odm-sw5e-token.txt").read().strip()

import http.cookiejar


class CookieSession:
    """urllib with a cookie jar — register returns a session COOKIE, not a token."""

    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, path, method="GET", body=None):
        headers = {"Content-Type": "application/json"}
        r = urllib.request.Request(BASE + path, method=method,
                                   data=json.dumps(body).encode() if body else None,
                                   headers=headers)
        try:
            resp = self.opener.open(r, timeout=30)
            return json.load(resp), None
        except urllib.error.HTTPError as e:
            return None, {"code": e.code, "body": e.read()[:300].decode(errors="replace")}


sess = CookieSession()

# 1. Campaign (idempotent: reuse if present)
camps, _ = call("/api/campaigns", tok=admin)
cid = next((c["id"] for c in camps.get("campaigns", []) if c["title"] == "Rogue One"), None)
if not cid:
    camp, err = call("/api/campaigns", "POST", {
        "title": "Rogue One",
        "description": "A ragtag band of Rebels must steal the plans to the Empire's "
                       "planet-killing battle station. Hope is a thing with blasters.",
        "theme": "Star Wars — Rebellion era, 0 BBY",
        "startingLevel": 5,
        "maxPlayers": 5,
    }, tok=admin)
    if err:
        print("campaign create failed:", err)
        raise SystemExit(1)
    cid = camp["campaign"]["id"]
else:
    # A previous run may have created it with placeholder text — fix the copy.
    call(f"/api/campaigns/{cid}", "PATCH", {
        "description": "A ragtag band of Rebels must steal the plans to the Empire's "
                       "planet-killing battle station. Hope is a thing with blasters.",
        "theme": "Star Wars — Rebellion era, 0 BBY",
    }, tok=admin)
print("campaign:", cid)

inv, err = call(f"/api/campaigns/{cid}/invite", "POST", tok=admin)
code = (inv or {}).get("inviteCode") or (inv or {}).get("code")
print("invite code:", code if code else err)

# 2. Party roster
PARTY = [    {"username": "jyn", "name": "Jyn Erso", "race": "human", "cls": "operative",
     "subclass": "Lethality Practice", "background": "criminal",
     "abl": {"str": 8, "dex": 15, "con": 13, "int": 10,
             "wis": 12, "cha": 14},
     "hp": 38, "ac": 15, "die": "d8", "gender": "Female",
     "appearance": "Dark-haired human woman, 24, wearing an Imperial inspection "
                   "disguise over a scavenger's jacket; kyber pendant at her neck."},
    {"username": "cassian", "name": "Cassian Andor", "race": "human", "cls": "scout",
     "subclass": "Stalker Technique", "background": "soldier",
     "abl": {"str": 10, "dex": 15, "con": 13, "int": 12,
             "wis": 14, "cha": 8},
     "hp": 44, "ac": 15, "die": "d10", "gender": "Male",
     "appearance": "Weathered human man, mid-30s, field jacket, heavy blaster "
                   "pistol worn low; the eyes of someone who has done terrible "
                   "things for the right side."},
    {"username": "chirrut", "name": "Chirrut Imwe", "race": "human", "cls": "monk",
     "subclass": "Whills Order", "background": "acolyte",
     "abl": {"str": 12, "dex": 14, "con": 13, "int": 8,
             "wis": 15, "cha": 10},
     "hp": 38, "ac": 15, "die": "d8", "gender": "Male",
     "appearance": "Blind human monk, 50s, layered robes, a staff of uneti wood "
                   "and a bowcaster of woven string; moves like he sees everything."},
    {"username": "baze", "name": "Baze Malbus", "race": "human", "cls": "fighter",
     "subclass": "Heavy Weapons Specialist", "background": "acolyte",
     "abl": {"str": 17, "dex": 12, "con": 15, "int": 10,
             "wis": 13, "cha": 9},
     "hp": 47, "ac": 16, "die": "d10", "gender": "Male",
     "appearance": "Broad human man, 50s, armor plating over desert robes, a "
                   "light repeater cannon across his back and a scowl for the "
                   "Force he no longer believes in."},
    {"username": "k2so", "name": "K-2SO", "race": "droid-classiv", "cls": "fighter",
     "subclass": "Assault Specialist", "background": "",
     "abl": {"str": 14, "dex": 12, "con": 16, "int": 14,
             "wis": 10, "cha": 8},
     "hp": 45, "ac": 17, "die": "d10", "gender": "",
     "appearance": "Tall black Imperial security droid, reprogrammed, expressive "
                   "photoreceptors, speaks blunt truth at volume."},
]

creds = {}
for p in PARTY:
    user = p["username"]
    pw = secrets.token_urlsafe(12)
    # Accounts exist from earlier runs: reset the password out-of-band (the
    # direct DB write is not throttled), then ONE login attempt per user.
    import subprocess
    r = subprocess.run(["node", "--experimental-strip-types",
                        "scripts/oc-poc-reset-user.mjs", user, pw],
                       cwd="/home/halr9000/projects/odm-sw5e", capture_output=True, text=True)
    if "rows updated: 1" not in r.stdout:
        print(f"{user}: reset failed: {r.stdout} {r.stderr}")
        continue
    sess = CookieSession()
    body, err = sess.call("/api/auth/login", "POST", {"username": user, "password": pw})
    if err or not body:
        print(f"{user}: cannot authenticate ({err})")
        continue
    creds[user] = pw
    time.sleep(8)
    body, err = sess.call("/api/campaigns/join", "POST", {"inviteCode": code})
    joined = "joined" if not err else f"join: {err}"
    lib, _ = sess.call("/api/characters")
    have = [c for c in (lib or {}).get("characters", []) if c.get("name") == p["name"]]
    if have:
        chd = have[0]
        seat, serr = sess.call(f"/api/campaigns/{cid}/sheet", "POST",
                               {"libraryCharacterId": chd["id"]})
        seatmsg = "seated" if not serr else f"seat: {serr}"
        print(f"{user}: already has {chd['id']}; {seatmsg}")
        p["cid"] = chd["id"]
        continue
    tool = {"jyn": ["Dice Set"], "cassian": ["Dice Set"],
            "chirrut": ["flute"], "baze": [], "k2so": []}[user]
    ch, err = sess.call("/api/characters", "POST", {
        "level": 5, "role": "pc",
        "sheet": {
            "name": p["name"], "race": p["race"], "class": p["cls"],
            "subclass": p["subclass"], "background": p["background"],
            "alignment": "", "gender": p["gender"], "appearance": p["appearance"],
            "abilities": p["abl"], "maxHp": p["hp"], "ac": p["ac"],
            "speed": 30, "hitDice": {"die": p["die"], "total": 5, "spent": 0},
            "proficiencies": {"saves": [], "skills": [], "languages": [],
                              "tools": tool, "armor": [], "weapons": []},
        },
    })
    if err:
        print(f"{user}: {joined}; CHARACTER FAILED: {err}")
        continue
    chd = ch.get("character") or ch
    seat, serr = sess.call(f"/api/campaigns/{cid}/sheet", "POST",
                           {"libraryCharacterId": chd["id"]})
    seatmsg = "seated" if not serr else f"seat: {serr}"
    print(f"{user}: {joined}; character {chd['id']} {chd.get('name')}; {seatmsg}")
    p["cid"] = chd["id"]

# 3. Active character per member (encrypted DB — node helper)
import subprocess
mapping = {p["username"]: p["cid"] for p in PARTY if p.get("cid")}
r = subprocess.run(
    ["node", "--experimental-strip-types", "scripts/oc-poc-set-active.mjs", cid, json.dumps(mapping)],
    cwd="/home/halr9000/projects/odm-sw5e", capture_output=True, text=True)
print(r.stdout.strip() or r.stderr.strip())

# 4. Lore entries
LORE = [
    ("The Galaxy in Revolt", "history",
     "The Empire rules through fear: stormtroopers on every civilized world, "
     "the Senate a rubber stamp, the DEATH STAR a rumor with a name. Wild Space "
     "burns with partisan cells — Saw Gerrera's Partisans foremost — while the "
     "rebellion coalesces around General Draven's intelligence arm and Mon "
     "Mothma's cautious coalition at Yavin 4."),
    ("Scarif — the Citadel", "geography",
     "A paradise world turned vault: turquoise seas, palm shores, and beneath "
     "them the Imperial Security Complex — planetary shield gate, anti-orbital "
     "turbolasers, and the archive tower where every critical document in the "
     "Empire is stored. The plans to the Death Star live here, under 'Starkiller "
     "Project'. The shield means nothing gets off-world without a gate code."),
    ("Jedha — the Holy City", "geography",
     "A desert moon sacred to the kyber-crystal faith, occupied by the Empire "
     "under the pretext of protecting pilgrims. Its streets hide zealots, "
     "Partisan insurgents, and the last masters of the Church of the Force. "
     "The Empire strips-mines kyber for something enormous."),
    ("Galen Erso's Hidden Message", "magic",
     "The Death Star's chief architect did not defect — he sabotaged. Hidden "
     "inside the station's technical readouts is a flaw only he could draw: a "
     "small thermal exhaust port, two meters wide, leading directly to the "
     "reactor system. The message travels through a pilot named Bodhi Rove and "
     "a Jedha courier to whoever is desperate enough to listen."),
    ("Director Krennic", "factions",
     "Orson Krennic, Imperial Advanced Weapons Research, commands the Death "
     "Star's construction and hunts Galen Erso's family across the galaxy. "
     "Death troopers with scrambled comms escort him. His rival is Grand Moff "
     "Tarkin; his leash is the Emperor's patience."),
    ("Saw Gerrera's Partisans", "factions",
     "The man who taught the rebellion extremism and was expelled for it. "
     "Gas-bombarded on Onderon, cybernetic legs, breathing apparatus, paranoid "
     "bunkers beneath Jedha's streets. He will torture an informant to save a "
     "rebellion that abandoned him — and he knows where Galen's daughter is."),
    ("Yavin 4 — Rebel Base", "geography",
     "A jungle moon and an abandoned Massassi temple, crowded with X-wings, "
     "U-wings and arguments. General Draven wants results without poltics; Mon "
     "Mothma wants a government worth restoring. Neither expects volunteers."),
    ("The Mission", "other",
     "An Imperial pilot defects carrying Galen Erso's message. Every faction "
     "converges on Jedha City. The party — assembled from a prison workhouse, "
     "a temple, and a reprogrammed droid — is the only team loose enough to "
     "reach the message before the Empire silences it. Beyond it: Eadu, then "
     "Scarif, then a war."),
]
posted = 0
existing = {e.get("title") for e in (call(f"/api/campaigns/{cid}/lore", tok=admin)[0] or {}).get("entries", [])}
for title, cat, body in LORE:
    if title in existing:
        posted += 1
        continue
    _, err = call(f"/api/campaigns/{cid}/lore", "POST",
                  {"title": title, "body": body, "category": cat}, tok=admin)
    if err:
        print(f"lore '{title}' failed:", err)
    else:
        posted += 1
print(f"lore posted: {posted}/{len(LORE)}")

os.makedirs("/tmp/sw5e-party-creds.json.d", exist_ok=True) if False else None
with open("/tmp/sw5e-party-creds.json", "w") as fh:
    json.dump({"campaign": cid, "users": creds}, fh)
os.chmod("/tmp/sw5e-party-creds.json", 0o600)
print("party creds -> /tmp/sw5e-party-creds.json")
print("DONE campaign", cid)

#!/usr/bin/env python3
"""Convert a FoundryVTT SW5e Actor export JSON into an ODM library character.

Usage: oc-fvtt-convert.py <fvtt-actor.json> [username]

Logs into the SW5e POC instance (http://neo.home:3210), maps the FVTT actor
system to ODM's createSheetSchema shape, and POSTs to /api/characters.
POC findings are printed as conversion notes.
"""
import base64
import json
import re
import sys
import time
import urllib.error
import urllib.request
import http.cookiejar

BASE = "http://neo.home:3210"

# FVTT 3-letter skill codes -> display names ODM shows
SKILL_NAMES = {
    "acr": "Acrobatics", "ani": "Animal Handling", "arc": "Arcana",
    "ath": "Athletics", "dec": "Deception", "his": "History",
    "ins": "Insight", "itm": "Intimidation", "inv": "Investigation",
    "med": "Medicine", "nat": "Nature", "per": "Perception",
    "prf": "Performance", "prc": "Persuasion", "pil": "Piloting",
    "slc": "Sleight of Hand", "ste": "Stealth", "sur": "Survival",
    "tec": "Technology",
    # SW5e-only skill the pack's skills table carries (resolved upstream
    # 2026-10: skillsInText now reads the active pack skill set).
    "lor": "Lore",
}
# Skill pools the pack's background rows offer (skillChoice.from), for the
# distribution pass: the converter reconstructs which proficient skills came
# from the background vs the class vs feat picks. Sources: pack rows
# (jensaarai) and the FVTT background's own list (scoundrel, POC finding 8b).
BG_SKILL_OFFERS = {
    "jensaarai": {"Insight", "Intimidation", "Lore", "Perception"},
    "scoundrel": {"Deception", "Insight", "Performance", "Sleight of Hand"},
}
PACK_DB = "/home/halr9000/projects/sw5e-odm-pack/sw5e.sqlite"


def _pack_row_text(table, name):
    """data_json text of the pack row whose name matches case-insensitively."""
    import sqlite3
    try:
        db = sqlite3.connect(f"file:{PACK_DB}?mode=ro", uri=True)
        row = db.execute(
            f"select data_json from {table} where lower(name)=lower(?)", (name,)
        ).fetchone()
    except Exception as exc:
        print(f"  warn: pack DB lookup failed for {table}/{name}: {exc}")
        return None
    return row[0] if row else None


def bg_skill_offers(bg):
    """Display-name set of the background's skill-choice pool, from the pack."""
    if not bg:
        return None
    raw = _pack_row_text("backgrounds", bg)
    if not raw:
        return None
    m = re.search(r"(?:one|two|three|four) of your choice from ([^.]+)", raw, re.I)
    if not m:
        return None
    valid = {v.lower() for v in SKILL_NAMES.values()}
    offers = {p.strip().lower() for p in re.split(r",| and ", m.group(1))}
    offers &= valid
    return offers or None


def feat_skill_grants(feat_names):
    """feat name -> skill names its pack row grants ('proficiency in the X skill')."""
    import json as _json
    grants = {}
    for name in feat_names:
        raw = _pack_row_text("feats", name)
        if not raw:
            continue
        try:
            txt = re.sub(r"<[^>]+>", " ", _json.dumps(_json.loads(raw)))
        except Exception:
            txt = raw
        for m in re.finditer(r"proficiency in the ([A-Za-z ]+?) skill", txt, re.I):
            grants.setdefault(name, []).append(m.group(1).strip())
    return grants


# SW5e weaponProf codes -> readable strings for ODM's free-text list
WEAPON_PROFS = {
    "sbl": "Simple blasters", "mbl": "Martial blasters",
    "svb": "Simple vibroweapons", "mvb": "Martial vibroweapons",
    "lgt": "Light weapons", "hvy": "Heavy weapons", "sim": "Simple weapons",
    "mar": "Martial weapons", "repeatingblaster": "Repeating blasters",
}
ARMOR_PROFS = {"lgt": "light armor", "med": "medium armor", "hvy": "heavy armor",
               "shl": "shields"}
# SW5e armor items are unknown to ODM's SRD-5.1 AC engine; naming the item
# with the closest SRD armor as a suffix lets the engine resolve it (POC
# finding 3 from the equipment round).
ARMOR_SRD_TAIL = {"light": "leather", "medium": "half plate", "heavy": "plate"}
FEAT_NOISE = {"Age", "Alignment", "Size", "Speed", "Defiant", "Human Versatility",
              "Languages", "Ability Score Increase", "Fighting Style"}


def open_json(path):
    with open(path) as fh:
        return json.load(fh)


class Odm:
    def __init__(self):
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, path, method="GET", body=None):
        status, data = self.try_call(path, method, body)
        if status != 200 and status != 201:
            raise SystemExit(f"{method} {path} -> HTTP {status}: {json.dumps(data)[:2000]}")
        return data

    def try_call(self, path, method="GET", body=None):
        req = urllib.request.Request(
            BASE + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json"})
        try:
            return 200, json.load(self.opener.open(req, timeout=30))
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:6000]
            try:
                return e.code, json.loads(detail)
            except json.JSONDecodeError:
                return e.code, {"error": detail}

    def login(self, username, password):
        self.call("/api/auth/login", "POST", {"username": username, "password": password})


def convert(actor):
    s = actor["system"]
    det = s["details"]
    items = actor.get("items", [])

    race = next((i["name"] for i in items if i["type"] == "race"), "Human")
    cls = next((i for i in items if i["type"] == "class"), None)
    subclass = next((i["name"] for i in items if i["type"] == "subclass"), "")
    bg = next((i["name"] for i in items if i["type"] == "background"), "")
    level = (cls or {}).get("system", {}).get("levels") or 1

    abilities = {k: int(v.get("value") or 10) for k, v in s["abilities"].items()}
    saves = [k for k, v in s["abilities"].items() if v.get("proficient")]

    skills, expertise = [], []
    # POC finding 8 (updated): ODM resolves SW5e's full skill set through the
    # mounted pack's skills table (Lore, Piloting, Technology included), so
    # nothing is dropped for vocabulary any more. The legality engine still
    # caps trained skills at background 2 + class 2 + feat choices + species
    # grants, so a flat list of every proficient FVTT skill is refused; the
    # converter must DISTRIBUTE them across sources.
    # The pack's skills table covers Technology/Piloting; nothing is skipped.
    trained = []
    for code, v in s.get("skills", {}).items():
        name = SKILL_NAMES.get(code)
        if not name:
            continue
        val = v.get("value") or 0
        if val >= 1:
            trained.append((name, val, code))

    # POC finding 8b (v3): FVTT sheets carry no per-skill provenance, so the
    # split is reconstructed. Offer pools and feat skill-grants are read from
    # the mounted pack DB rather than hand-maintained dicts. Order:
    #   1. a trained skill exactly one actor feat can grant (and which no
    #      background offers) rides that feat via sheet.featChoices;
    #   2. up to 2 from the background's offer pool;
    #   3. the next 2 are the class's picks (a class offers all 18);
    #   4. leftovers ride any granting feat, else Practiced if the actor has
    #      it, else are dropped with a warning.
    # The flat `skills` list carries EVERY trained skill; legality subtracts
    # the feat picks before judging offers and re-applies them through
    # applyFeatGrants (sheet-legality issue #147). featChoices keys must name
    # feats the sheet actually has or the engine ignores them (Maurice bug).
    feat_choices = {}
    feat_names = [i["name"] for i in items if i["type"] == "feat"]
    feat_grants = feat_skill_grants(feat_names)
    if trained:
        skills = [n for n, val, code in trained]
        grant_map = {}
        for fname, sks in feat_grants.items():
            for sk in sks:
                grant_map.setdefault(sk.lower(), []).append(fname)
        bg_offers = bg_skill_offers(bg)
        assigned = {n for n, val, code in trained
                    if len(grant_map.get(n.lower(), [])) == 1
                    and (not bg_offers or n.lower() not in bg_offers)}
        for n in assigned:
            feat_choices.setdefault(grant_map[n.lower()][0], {"skills": []})["skills"].append(n)
        remaining = [(n, val, code) for n, val, code in trained if n not in assigned]
        if bg_offers:
            bg_picked = [n for n, val, code in remaining if n.lower() in bg_offers][:2]
        else:
            bg_picked = [n for n, val, code in sorted(remaining, key=lambda t: -t[1])[:2]]
        remaining = [(n, val, code) for n, val, code in remaining if n not in bg_picked]
        leftover = remaining[2:]  # first two of what's left are the class's picks
        for n, val, code in leftover:
            fs = grant_map.get(n.lower(), [])
            if fs:
                feat_choices.setdefault(fs[0], {"skills": []})["skills"].append(n)
            elif "Practiced" in feat_names:
                feat_choices.setdefault("Practiced", {"skills": []})["skills"].append(n)
            else:
                print(f"  warn: trained skill '{n}' has no granting feat; dropped")
    else:
        skills = []

    wp = s["traits"].get("weaponProf", {}).get("value") or []
    ap = s["traits"].get("armorProf", {}).get("value") or []
    tools = [next((i["name"] for i in items
                   if i["type"] == "tool" and i["system"].get("identified", True)),
                  None)] if False else []
    for code, v in (s.get("tools") or {}).items():
        if v.get("value"):
            label = code.replace("_", " ").title()
            label = {"Disguisekit": "Disguise kit",
                     "Tinkersimplements": "Tinker's implements"}.get(label, label)
            tools.append(label)

    # Inventory: weapons/consumables/equipment/loot/tools -> equipment rows.
    # Credits stay out (currency maps to gold).
    equipment = []
    for i in items:
        if i["type"] not in ("weapon", "equipment", "consumable", "loot", "tool"):
            continue
        if i["type"] == "loot" and "credit" in i["name"].lower():
            continue
        name = i["name"]
        qty = int(i["system"].get("quantity") or 1)
        row = {"name": name[:80], "qty": qty}
        if i["type"] == "equipment" and (i["system"].get("armor") or {}).get("value"):
            worn = bool(i["system"].get("equipped"))
            typ = ((i["system"].get("type") or {}).get("value")) or "light"
            if worn:
                name_fvtt = name
                row["name"] = f"{name_fvtt} - {ARMOR_SRD_TAIL.get(typ, 'leather')}"[:80]
                row["equipped"] = True
        equipment.append(row)

    # POC finding 11: the import door caps carried coin at 1000 gp at level 8
    # ("let whoever runs the table award the rest").
    gold = min(int((s.get("currency") or {}).get("gc") or 0), 1000)
    hp = int(s["attributes"]["hp"]["value"] or 10)
    # AC: derive from the mapped armor via ODM's engine (acOverride false).
    # If nothing armors up, fall back to 10 + dex.
    dex = abilities["dex"]
    mods = {score: (score - 10) // 2 for score in range(6, 21, 2)}
    dex_mod = mods.get(dex, mods[max(k for k in mods if k < dex)] if dex > 20 else 0)
    ac = 10 + dex_mod
    for i in items:
        if i["type"] == "equipment" and (i["system"].get("armor") or {}).get("value") and i["system"].get("equipped"):
            typ = ((i["system"].get("type") or {}).get("value")) or "light"
            dex_cap = 10 if typ == "medium" else None
            ac = int(i["system"]["armor"]["value"]) + (min(dex_mod, 2) if dex_cap else dex_mod)
            break

    die = {"d6", "d8", "d10", "d12"}
    # SW5e hit dice: prefer the class item's hitDie field if present.
    hd_die = ((cls or {}).get("system", {}).get("hitDie") or "d8")
    hd_die = hd_die if hd_die in die else "d8"

    feats_all = [i for i in items if i["type"] == "feat"]
    # POC finding 5: feats beyond ASI slots + racial grants are refused, and
    # FVTT's "feat" items mix real feats with class features and species
    # traits (system.type.value: class / species / feat / customizationOption).
    # Only true feats go in `feats`; everything else lands on the sheet as
    # `features`, which is displayed but not slot-judged.
    feats_sheet = []
    features = []
    for i in feats_all:
        ftype = i["system"].get("type", {}).get("value") if isinstance(i["system"].get("type"), dict) else None
        name = i["name"]
        if ftype == "class":
            # POC finding 12: on write, "class"- and "race"-sourced features
            # are REGRANTED from SRD/pack data (which for pack classes is
            # nearly empty), wiping what the import carried; "feat"-sourced
            # names that are mechanical (Fighting Style, Extra Attack) are
            # refused outright. "story" survives, except mechanical names
            # (see the retry loop in main()).
            features.append({"name": name[:80], "source": "story"})
        elif ftype == "species":
            features.append({"name": name[:80], "source": "story"})
        else:  # feat / customizationOption / blank
            # POC finding 6: FVTT "customizationOption" rows (Snapshot Style)
            # and untyped rows (Minimum Roll Threshold) are subclass choices,
            # not feats — ODM refuses unknown names in the slot-judged list,
            # so only literal type "feat" goes to `feats`.
            src = "choice" if ftype == "customizationOption" else "feat"
            if ftype == "feat":
                feats_sheet.append(name)
            else:
                features.append({"name": name[:80], "source": src})
    asis_earned = max(0, sum(1 for lv in (4, 8, 12, 16, 19) if lv <= level))
    asi_choices = [{"mode": "feat", "feat": f} for f in feats_sheet[:asis_earned]]

    spells = [(i["name"], int(i["system"].get("level") or 0),
               bool((i["system"].get("preparation") or {}).get("prepared")))
              for i in items if i["type"] == "spell"]
    cantrips = [n for n, lvl, _ in spells if lvl == 0]
    known = [n for n, lvl, _ in spells if lvl > 0]
    prepared = [n for n, lvl, prep in spells if lvl > 0 and prep]
    if spells:
        # POC finding 10: ODM's caster detection reads spellcasting_ability
        # from the class row, which the SW5e pack classes lack — a scout is
        # "no Spellcasting feature", so tech powers cannot ride the
        # spellcasting block. They are recorded as a class feature instead.
        # Techcasting feature appended by the spells block below uses "feat" too
        features.append({
            "name": f"Techcasting (powers: {', '.join(n for n, _, _ in spells)})"[:80],
            "source": "feat",
        })
        spellcasting = None

    # Appearance: ODM caps it at 500; the FVTT biography (2-3k chars of HTML)
    # belongs in `backstory` (party-visible, woven into the DM prompt, max
    # 2000) with the remainder in `notes` (owner-private, max 4000).
    bio = (det.get("biography") or {}).get("value") or ""
    bio = re.sub(r"<[^>]+>", "\n", bio)
    bio = re.sub(r"\n{2,}", "\n", bio).strip()
    look_bits = [det.get("gender"), det.get("age"), det.get("height"), det.get("hair"), det.get("eyes")]
    look = ", ".join(b for b in look_bits if b and str(b).strip())
    appearance = f"{look}. {bio[:400]}".strip()[:500] if (look or bio) else ""
    backstory = bio[:2000]
    notes = bio[2000:4000]

    sheet = {
        "name": actor["name"][:60],
        "race": race[:60],
        # POC finding 4: the archetype lookup filters class_slug = ? with the
        # sheet's raw class string, so subclasses only resolve when the class
        # is sent as the pack SLUG ("scout"), not the display name.
        "class": (cls["name"] if cls else "Adventurer").lower()[:60],
        "subclass": subclass[:60],
        "background": (bg or "").lower()[:60],
        "alignment": str(det.get("alignment") or "")[:30],
        "gender": str(det.get("gender") or "")[:30],
        "appearance": appearance,
        "abilities": abilities,
        "maxHp": hp,
        "ac": ac,
        "acOverride": False,
        "speed": 30,
        "hitDice": {"die": hd_die, "total": level, "spent": 0},
        "proficiencies": {
            "saves": saves,
            "skills": skills,
            "expertise": expertise,
            "languages": [],
            "tools": tools,
            "armor": [ARMOR_PROFS.get(a, a) for a in ap][:8],
            "weapons": [WEAPON_PROFS.get(w, w) for w in wp][:16],
        },
        "equipment": equipment[:60],
        "gold": gold,
        "feats": feats_sheet,
        "featChoices": feat_choices,
        "asiChoices": asi_choices,
        "features": features[:80],
        "backstory": backstory,
        "notes": notes,
    }
    if spellcasting:
        sheet["spellcasting"] = spellcasting
    return sheet


def fetch_portrait(url):
    """Download the FVTT actor image into an ODM bundle portrait (base64)."""
    if not url or not url.startswith("http"):
        return None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "odm-fvtt-convert/1"})
        data = urllib.request.urlopen(req, timeout=20).read()
        if not data or len(data) > 4_000_000:
            return None
        kind = "image/png"
        if data[:3] == b"\xff\xd8\xff":
            kind = "image/jpeg"
        elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            kind = "image/webp"
        name = url.rsplit("/", 1)[-1][:60] or "portrait"
        return {"name": name, "type": kind,
                "dataUrl": f"data:{kind};base64,{base64.b64encode(data).decode()}"}
    except Exception as error:
        print(f"  portrait skipped ({error})")
        return None


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    actor = open_json(sys.argv[1])
    username = sys.argv[2] if len(sys.argv) > 2 else None
    creds_path = "/home/halr9000/projects/odm-sw5e/.admin-creds"
    if username:
        import json as _j
        pw = _j.load(open("/tmp/sw5e-party-creds.json"))["users"][username]
    else:
        lines = [l.strip() for l in open(creds_path) if l.strip()]
        username, pw = lines[0], lines[1]
    odm = Odm()
    odm.login(username, pw)
    time.sleep(1)
    sheet = convert(actor)
    print(f"Converting {sheet['name']}: "
          f"{sheet['race']} {sheet['class']}/{sheet['subclass'] or '-'} {sheet['level'] if hasattr(sheet,'level') else '?'}")
    body = {"level": 1, "role": "pc", "sheet": sheet}
    # createSheetSchema has no level inside sheet; POST takes {level, role, sheet}
    body["level"] = (next((i["system"].get("levels") for i in actor["items"]
                           if i["type"] == "class"), 1))
    # POC finding 7: the plain library door runs the same ability-METHOD check
    # as the builder ("scores" policy), which FVTT scores (rolled/elite arrays)
    # fail. The IMPORT door accepts bounds-checked scores, so the character is
    # sent as ODM's own export-bundle format instead.
    from datetime import datetime, timezone
    bundle = {
        "kind": "odm.character",
        "version": 1,
        "exportedAt": datetime.now(timezone.utc).isoformat()[:32],
        "name": sheet["name"],
        "level": body["level"],
        "sheet": sheet,
    }
    portrait = fetch_portrait(actor.get("img"))
    if portrait:
        bundle["portrait"] = portrait
    # POC finding 13: story-sourced features whose names are mechanical in
    # the 5e engines (Fighting Style, Extra Attack, Expertise, …) are refused
    # even on the import door. The refusal names them; drop and retry.
    res: dict = {}
    for _ in range(3):
        status, res = odm.try_call("/api/characters/import", "POST", bundle)
        if status in (200, 201):
            break
        refused = [m.group(1) for p in (res.get("problems") or [])
                   if (m := re.match(r'"(.+?)" is a (?:story|feat) feature', str(p)))]
        if not refused:
            raise SystemExit(f"import -> HTTP {status}: {json.dumps(res)[:2000]}")
        sheet["features"] = [f for f in sheet["features"] if f["name"] not in refused]
        print(f"  retry: dropped refused features {refused}")
    print("created:", json.dumps(res.get("character", res))[:200])
    # Stage 1 of the reconciliation policy (docs/reconciliation-policy.md):
    # the created character runs through the deterministic reconcile —
    # legacy spellings canonicalized, provable grants applied — before the
    # converter exits. Its log is what the Stage 2 agent (in conversation)
    # reads; a partial or failure result is reported, never hidden.
    character_id = ""
    if isinstance(res, dict):
        created = res.get("character")
        if isinstance(created, dict):
            character_id = created.get("id") or ""
    if character_id:
        import subprocess
        proc = subprocess.run(
            ["node", "scripts/reconcile-sheet.mjs", "--character", character_id, "--apply"],
            capture_output=True, text=True, timeout=120,
        )
        print(proc.stderr.strip())
        if proc.returncode != 0:
            print(f"  reconcile result: {proc.stdout.strip()} (exit {proc.returncode}) — see the log for the flags")


if __name__ == "__main__":
    main()

# Glossary

Terms specific to this repo and the SW5e conversion work. Keep entries short; link to docs when a term needs more than a paragraph.

## ODM terms

- **Content pack** — a separate read-only SQLite database (Open5e format) attached via `CONTENT_DB_PATH`; holds rules data (classes, races, spells, items, monsters) distinct from campaign content. See `src/lib/content/`.
- **Legality engine** — `src/lib/srd/sheet-legality.ts` + `src/lib/srd/legality/*`: validates a character sheet against known classes/races/backgrounds/feats/skills/spells at create, level-up, and import. Doors: `library`, `table`, `engine`, `import`, `stored` — each with a different policy (`scores` method vs bounds, `plainStory`, `trustsHeld`).
- **Import door** — `POST /api/characters/import` consuming the character bundle (`{kind: "odm.character", version: 1, sheet, portrait?}`); accepts bounds-checked ability scores. Export (`GET /api/characters/[id]/export`) is its mirror.
- **Gear engine** — homebrew/pack equipment rows carry a `gear` block (armor/attack/magic data) snapshotted on read (`src/lib/homebrew/gear.ts`, `src/lib/srd/armor.ts`).

## SW5e conversion terms

- **Pack** (this project) — the SW5e content pack built by the sibling `sw5e-odm-pack` repo: 13 tables of SW5e rules data in ODM's Open5e row format.
- **SRD tail matching** — ODM's armor engine resolves armor by the name's tail against the hardcoded SRD 5.1 table; SW5e armor rows must be named `<SW5e name> - <SRD name>` to resolve.
- **POC instance** — `odm-sw5e.service`, second ODM checkout pinned to port 3210, `CONTENT_DB_PATH` pointed at the SW5e pack, app DB `data/sw5e-app.sqlite`.
- **Techcasting / Forcecasting** — SW5e power-casting abilities (INT/WIS/CHA based), mapped to ODM's spellcasting where the class row declares `spellcasting_ability`.

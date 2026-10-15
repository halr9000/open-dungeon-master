# SW5e POC instance notes

This checkout is a **copy of the open-dungeon-master fork tree** (not a git clone of it) — only the
POC-specific scripts under `scripts/oc-*` are tracked on branch `sw5e-poc`, pushed to
`halr9000/open-dungeon-master`. The full tree stays untracked; re-sync by copying from
`~/projects/open-dungeon-master`.

## What lives here
- `scripts/oc-fvtt-convert.py` — FoundryVTT SW5e actor JSON → ODM import-bundle converter (usage in file header).
- `scripts/oc-build-rogue-one.py`, `oc-start-table.py` — campaign/party bootstrap.
- `scripts/oc-poc-outfit-party.mjs` — equipment writer for `equipment_json` (idempotent).
- `scripts/oc-poc-{list-users,verify-admin,reset-admin,reset-user,set-active}.mjs` — admin/user tooling.

## Not committed (by design)
- `data/` — encrypted app DBs (`chacha20`, own `DB_ENCRYPTION_KEY` in `.env.server`).
- `.env*`, `.admin-creds`, `models/`, `uploads/`, `node_modules/`, `.next/`.

## Content pack
Built by the sibling repo `~/projects/sw5e-odm-pack` (github.com/halr9000/sw5e-odm-pack),
attached via `CONTENT_DB_PATH=~/projects/sw5e-odm-pack/sw5e.sqlite`.

## Findings tracking
GitHub issues in `halr9000/open-dungeon-master`, epic #1, labels: `sw5e`, `poc`,
`pack`, `conversion`, `upstream-candidate`. Triage vocabulary: docs/agents/triage-labels.md.

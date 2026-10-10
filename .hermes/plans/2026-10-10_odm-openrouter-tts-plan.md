# ODM TTS/OpenRouter Features Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make OpenRouter a first-class ODM backend for text + TTS with unified key management, filterable model pickers, voice listers with discovery links, and a fixed voice-test button.

**Architecture:** All TTS traffic flows through `src/lib/tts-backend.ts` (pure, fully unit-tested logic) → `/api/tts/*` routes → UI. OpenRouter is added as a TTS provider reusing the existing OpenAI-compatible wire format; its key resolver plugs into the existing `resolveCustomKey` pattern. Model picking gets a new `FilterableModelPicker` component replacing flat Radix Selects where lists can be large.

**Tech Stack:** Next.js 16 (Turbopack), TypeScript, zod schemas, Radix UI, vitest, node `test-*.mjs` harness pattern for API-level tests.

**Test baseline (established 2026-10-10):** `narration-tts-backend.test.mjs` = 21 checks passing. Env: dev server runs under Node 24 (`~/.nvm/.../v24.18.1/bin`), `npm run dev:lan` on port **8100**, SQLite native module is built for Node 24 ABI.

---

## Task 1: Extend TTS schema with openrouter provider

**Objective:** Allow `openrouter` as a `ttsProvider` value end-to-end at the schema level.

**Files:**
- Modify: `src/lib/tts-backend.ts:20` — `TtsProvider` type: add `"openrouter"`
- Modify: `src/lib/schemas/global-config.ts:112` — `ttsProvider: z.enum(["", "kokoro", "openai", "openrouter", "off"])`
- Test: extend `tests/narration-tts-backend.test.mjs` (or colocated vitest equivalent per file header)

**Steps:**
1. Write failing test: `resolveTtsBackend({provider:"openrouter", openrouterUrl:"https://openrouter.ai/api/v1", ...})` returns backend with `v1` root and key required.
2. Run → FAIL.
3. Add `"openrouter"` to `TtsProvider`. In `resolveTtsBackend` (line 79) add branch: `openrouter` → base `https://openrouter.ai/api/v1`, model default `"hexgrad/kokoro-82m"`, defaultVoice `"af_heart"`.
4. Update zod enum. Run tests → PASS.
5. Commit: `feat(tts): add openrouter tts provider type`

## Task 2: Key resolution — one OpenRouter key for text + TTS

**Objective:** TTS requests to `openrouter.ai` automatically use the configured OpenRouter key; no pasted endpoint, no separate key.

**Files:**
- Modify: `src/lib/model-client.ts` — reuse the existing `resolveCustomKey`/`OPENROUTER_API_KEY` env fallback logic; extract to shared helper if not already exported (search `OPENROUTER_API_KEY` in `src/lib/` — 5 hits)
- Modify: `src/lib/tts-backend.ts:58` `isOpenAiHost()` or its call site (line 300): currently `if (!isOpenAiHost(backend.v1))` skips Authorization header. Add `isOpenRouterHost()` (host check `openrouter.ai`) and include `Authorization: Bearer <openrouterKey>` when provider is `openrouter`.
- Modify: `src/lib/openai-images.ts:81` `openAiSpeechConfig()` — when TTS provider is openrouter, return openrouter key + base URL.
- Test: unit test for header inclusion; `.mjs` harness asserting `Authorization` present for openrouter base, absent for plain kokoro.

**Notes:**
- Server-side only; keys never reach client.
- OpenRouter chat-completions key (`sk-or-...`) works for `/api/v1/audio/speech` on OpenRouter (verified upstream docs 2026-10).
- Setup wizard: flip `coversMedia: false → true` for the OpenRouter `KeyProvider` so a configured OpenRouter key satisfies TTS onboarding (file: `src/lib/setup/discovery-logic.ts`, search `coversMedia`).

## Task 3: Admin + setup UI for OpenRouter TTS

**Objective:** User selects provider "OpenRouter (uses your OpenRouter key)" in both Speech settings and setup wizard; no URL field needed for OpenRouter.

**Files:**
- Modify: `src/app/admin/AdminSpeechSection.tsx` (~264 lines; speech dropdown at top with `ttsProvider` state)
- Modify: `src/app/admin/AdminSettingsFields.tsx` (`speech` draft shape line 37, props line 66)
- Modify: setup wizard speech step in `src/app/setup/MediaSteps.tsx` (same provider select pattern)
- Modify: `src/app/api/admin/tts-test/route.ts` — accept provider `openrouter`

**Steps:**
1. Add option to provider Selects. When `openrouter`: hide `ttsBaseUrl`/`kokoroUrl` fields, show note "Uses your OpenRouter API key" + link to keys page.
2. When provider is openrouter and no key resolved, show inline warning (reuse `hasTtsApiKey` pattern — add `hasOpenRouterKey`).
3. Keep `ttsModel` visible with placeholder `hexgrad/kokoro-82m` (feeds Task 5 model picker).
4. Manual verify: switch provider, save, reload → settings persist.
5. Commit: `feat(admin+setup): openrouter tts provider UI`

## Task 4: Cached model lister with typeahead (FilterableModelPicker)

**Objective:** OpenRouter's ~400-model catalog (and any provider's list) searchable inline, sortable newest-first, cached to avoid refetches.

**Files:**
- Create: `src/components/FilterableModelPicker.tsx` (client component)
  - Props: `models: ListedModel[]`, `value`, `onChange`, `placeholder?`
  - Combobox pattern: text input filters (case-insensitive substring on id + name), shows top 20 matches, keyboard nav (↑↓ Enter Esc), "Sort: newest" toggle using `ListedModel.created` (unix seconds; models without `created` sort last)
- Modify: `src/lib/setup/discovery-logic.ts:81` `ListedModel` — add optional `created?: number`; populate in `readModelList` (line 118) from OpenAI-style `/v1/models` payload (`m.created`), normalize ms vs s
- Modify consumers: `StorytellerStep.tsx` (uses big list), `AdminSettingsFields`/`AdminSpeechSection` (ttsModel), any admin model fields with large lists. Keep plain `Select` where lists are small (<25 items) — YAGNI.
- Test: vitest for filter/sort helpers (pure functions extracted: `filterModels(models, query, sort)`)

**Steps:**
1. Write failing vitest for `filterModels` (query match, newest sort, missing-created last).
2. Implement helper → PASS.
3. Build `FilterableModelPicker` with extracted helper; a11y: `role="combobox"` + `aria-expanded`.
4. Wire into StorytellerStep first (biggest win), then TTS model field.
5. Manual: OpenRouter key + `/v1/models` → typeahead filters live; sort toggle works.
6. Commit: `feat(ui): filterable model picker with newest-first sort`

## Task 5: Voice lister + voice-ID discovery links

**Objective:** Where a TTS server can list voices, show them; where it can't, give a click-through to the right docs/IDs page.

**Files:**
- Modify: `src/lib/tts-backend.ts:151` `fallbackVoices()` — add openrouter branch: return known Kokoro voice ids (same list as kokoro branch — OpenRouter's kokoro-82m accepts the same 54 voice names)
- Modify: `src/lib/tts-backend.ts:300` region — add `voiceDocsUrl(backend)`: kokoro → its `/v1/voices` still works; openai → `https://platform.openai.com/docs/guides/text-to-speech/voices`; openrouter → `https://openrouter.ai/docs` audio section anchor
- Modify: `src/app/api/tts/voices/route.ts` — include `docsUrl` in payload (read-only, no key)
- Modify: `AdminSpeechSection.tsx` + `MediaSteps.tsx` voice field: below the picker, render `docsUrl` as a small "Find voice IDs ↗" link (new window) when `listed === false` or always as secondary link
- Test: unit test for `voiceDocsUrl` mapping.

**Note:** `/api/tts/voices` already implements the lister pattern (serverVoices + `listed` flag + fallback) — this task mostly extends it, doesn't rebuild it.

## Task 6: Fix voice-test button (passes but no audio)

**Objective:** NarrationTest (setup) and AdminSpeechSection test must actually play audio, and surface failures when they can't.

**Root cause analysis (from code read 2026-10-10):**
- `src/app/api/admin/tts-test/route.ts` returns audio bytes on success. Both `NarrationTest` and `AdminSpeechSection` create an `Audio()` element and call `.play()`; the promise is ignored or `.catch(() => {})` — autoplay-policy rejections (play not in direct user-gesture context after `await fetch`) are swallowed, and element `onerror` is unhandled. Result: probe says "passed" (HTTP 200) but zero sound.
- `VoicePreviewButton.tsx` already does this correctly (catches, re-fetches for error JSON, surfaces message) — copy its pattern.

**Files:**
- Modify: `src/app/setup/MediaSteps.tsx` NarrationTest component
- Modify: `src/app/admin/AdminSpeechSection.tsx` test handler

**Steps:**
1. In both: after fetch resolves OK, `const blob = await res.blob(); const url = URL.createObjectURL(blob); const a = new Audio(url); try { await a.play(); setStatus("✓ playing") } catch (e) { setStatus("✗ audio blocked: " + e.message) }` — the `await` chain is fine as long as play() errors are surfaced.
2. When `res.ok === false`: fetch error JSON and show `describeSpeechFailure` wording (already exists in tts-backend).
3. Revoke object URL on unmount.
4. Manual test with a running TTS server (kokoro on :8880 or OpenRouter cloud): confirm sound + failure path shows message when provider is off.
5. Commit: `fix(speech): surface audio playback failures in test buttons`

## Task 7: Regression sweep + upstream PR prep

**Objective:** Everything green; changes structured for upstream contribution.

**Steps:**
1. `npx vitest run` full suite → green (baseline: 246 files passing).
2. `node scripts/test-tts-backend.mjs` → all checks pass (extend its checks for openrouter provider).
3. Squash feature commits into reviewable series; `git log --oneline upstream/main..` should read as clean feature commits.
4. Open draft PR to `Lebbitheplow/open-dungeon-master` with: summary, screenshots of picker + speech section, note that OpenRouter TTS is additive (no behavior change for kokoro/openai/off users).

---

## Environment gotchas (for implementer)

- **Dev server:** `npm run dev:lan` (port 8100, set in package.json). Must run under Node 24: `PATH=/home/halr9000/.nvm/versions/node/v24.18.1/bin:$PATH npm run dev:lan`. Node 26 breaks the SQLite native module (ABI mismatch).
- **Env files:** `.env.local` has `ALLOWED_DEV_ORIGINS=neo.home,neo,192.168.2.30,neo.taileffc7.ts.net`; `.env.server` has `DB_ENCRYPTION_KEY` (regenerating it loses existing accounts).
- **LAN access:** `http://neo.home:8100` — port 8100 added to firewalld home zone (runtime only; permanent fix pending — see networking follow-up).
- **Test commands:** vitest for unit (`npx vitest run <file>`), `.mjs` scripts run standalone with node and often need the dev server up.
- **DB:** `better-sqlite3-multiple-ciphers`; never commit `.env*` or `db/`.

## Open questions

1. Should OpenRouter TTS voice preview go through the server (key stays server-side) — yes, but confirm OpenRouter allows `/audio/speech` streaming for previews without rate issues.
2. Does the user want per-campaign TTS overrides, or global-only? (Assume global-only — YAGNI.)
3. `coversMedia: true` for OpenRouter changes setup-wizard gating — verify it doesn't force key entry when user only wants local kokoro.

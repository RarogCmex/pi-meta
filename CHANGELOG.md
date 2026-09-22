# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Transparent retry of transient Meta failures at the provider seam: `createMetaProviderConfig()` now registers `streamSimple`, which re-issues the same context and options for gateway/5xx/overload errors (up to 3 retries, 2s→4s→8s backoff capped at 30s) so the model never sees a failed turn or a retry nudge. Mirrors `pi-nvidia-plus`'s transport-level retry without an undici dispatcher.
- Exhaustion delivers the original error byte-for-byte; retries and give-ups are surfaced as pi notifications when a UI is present. Disable with `META_TRANSPORT_RETRY=0`.
- Non-transient failures fail fast and are never re-sent: `reasoning.encrypted_content` denials, `model_not_found`, auth, quota/billing (`insufficient_quota`, `GoUsageLimitError`, `out of budget`), content filters, bad requests, and context overflow.
- An attempt that already delivered content to pi is never replayed, so a partial answer is surfaced unchanged rather than duplicated.
- Learning from terminal errors: an `encrypted_content` denial marks the (key, model) as unentitled so later requests strip the include, and a `model_not_found` turn kicks a cooldown-guarded live-catalog repair.
- Wire-level retry coverage in `tests/meta-retry.test.ts` (scripted inner Responses implementation, no network), including the measured 504 `gateway_timeout` body.

## [0.7.0] - 2026-09-20

### Added

- Pi 0.86.x support: peer range `>=0.83.0 <0.87.0`, devDeps 0.86.1, `TranscriptContext`-branded stream tests.
- Live catalog self-discovery on `session_start`: pi 0.86 runs all in-session refreshes with `allowNetwork: false` (and its startup refresh storm supersedes extension-triggered live passes), so the extension now fetches `GET /v1/models` itself with the resolved key and re-registers the provider with the fetched ids. This is what makes keys whose catalog exposes only account-specific ids (e.g. `rl-muse-spark-1-3-sglang-playground`) work at all — pi's built-in Meta provider ships a static `muse-spark-*` catalog and answers HTTP 404 `model_not_found` for such keys.
- `compat.supportsStrictMode: true` on every Muse model: pi 0.86 enables strict-prefer JSON-schema sampling for `read`/`bash`/`edit`/`write` by default, and Meta accepts strict tools once the schema carries `additionalProperties: false` (measured 2026-09-20).
- `oauth.isSubscription: true`, matching pi's built-in provider so usage renders as "(sub)".
- Entitlement probe for `reasoning.encrypted_content` is now keyed per (key, model) and names the model actually in use; a fixed probe id would read 404 `model_not_found` as "not entitled" for account-scoped keys.

### Changed

- `compat.supportsToolSearch: false`: Meta accepts `tool_search_call`/`tool_search_output` items but ignores them — a tool announced only through them is never called, while the same tool in `tools` is (measured 2026-09-20). With tool search off, pi always sends the full current tool list, including tools added mid-conversation.
- Bare catalog entries (no `metadata["muse-code"]` block) now default to `input: ["text", "image"]` instead of text-only: Muse Spark answers image input on bare account-scoped ids (measured 2026-09-20).
- Offline refresh phases republish and persist the process's own live catalog, repairing a stale `models-store.json` written by pi's built-in static provider (`pi update --models` does not load extensions).
- Live test probes resolve the credential from `auth.meta.key` (api-key shape) as well as `auth.meta.access` (oauth shape), and pick the cache-probe model from the live catalog.

### Fixed

- Catalog mapping deduplicates ids, tolerates blank/whitespace display names, and normalizes `displayName()` separators (uncommitted work from the previous session, now covered by tests).
- `muse-spark-1.3` fallback maps thinking `max` → `max`, standard 1.3 being the only Spark that does (upstream PR #14).
- Per-key entitlement probe for `reasoning.encrypted_content`; the include is stripped for keys Meta rejects, so cross-turn reasoning never 400s (upstream PR #18).
- API-key identification: `/login meta` offers a method choice between the browser device flow and pasting a Model API key. Pasted keys are validated against `GET /v1/models`, stored with a `static-api-key:` refresh marker, and passed through unchanged by the daily refresh.

## [0.6.1] - 2026-09-04

### Fixed

- Direct expired Meta identity-token sessions back to `/login meta` when API-key minting returns HTTP 401 or 403.

## [0.6.0] - 2026-09-04

### Removed

- Voice dictation, platform audio helpers, and Meta ASR integration from the OAuth-only branch.
- Media analysis tools, commands, upload helpers, and request rewriting from the OAuth-only branch.
- Unused `@earendil-works/pi-tui` and `typebox` runtime peer dependencies.

### Changed

- Register only `extensions/meta.ts` and advertise only Pi-native text and image model inputs.

## [0.5.0] - 2026-09-03

### Added

- Send `prompt_cache_retention: "24h"` on Meta Responses requests (chat hook and direct media calls). Muse prompt caching is opt-in and measured ~0% on `/chat/completions` vs 93–99% on `/responses` with this hint.
- Strip `reasoning.effort: "none"` from outbound payloads — Meta 400s on it.
- Hermetic wire-contract tests for the Responses URL, retention setdefault/override, reasoning omit/passthrough, session `prompt_cache_key` stability, contributor cache pricing, and the ASR handshake JSON.
- Optional live prompt-cache probe (`PI_META_LIVE_API_KEY`, or any already-available Meta credential) that performs two identical Responses calls — plus one retry on a cache miss — and asserts `cached_tokens`.
- Bundled model metadata for `muse-spark-1.3` and `muse-spark-1.3-contributor`.

## [0.4.4] - 2026-08-17

### Added

- Persist the live Meta catalog to `~/.pi/agent/models-store.json` after a successful network refresh, so external usage tools can show context-window percentages.
- Restore that cached catalog when Pi starts offline or without a Meta API key; bundled fallbacks remain the last resort.
- Compatibility adapter for both Pi 0.83 (`store` read/write) and Pi 0.84 (`stored` / `publish`).
- Contributor-model privacy note for `muse-spark-1.2-contributor`.
- Documented `MUSE_VOICE_ASR_ENDPOINT` / `MUSE_VOICE_ASR_MODEL` aliases (`PI_META_*` takes precedence).

### Fixed

- Treat Pi 0.84's `AbortSignal` as token-refresh cancellation instead of a `fetch` mock, so `/login meta` key rotation works on Pi 0.84.2.
- Do not persist or publish an empty catalog; restore the previous cache when a refresh returns no models or fails on the network.
- Force `store:false` and Files API promotion for large media in tool `output` arrays and ordinary `input_image` data URLs, avoiding Meta's ~20 MB `store=true` 413 limit.
- Rewrite media HTTPS URLs that include query strings or fragments.
- Validate video/audio MIME types from the full source URL, not only the path suffix.
- Honor abort signals on Files API uploads and check the 1 GiB size limit before buffering the file.
- Stage macOS codesign and Windows `csc` output so a failed helper compile cannot leave a half-built binary that skips later signing.
- Sample every 16-bit PCM frame in the voice meter (2-byte stride, not 4).
- Complete a voice session on ASR close only for normal close codes 1000/1005.

### Changed

- Split media internals into `extensions/media/{limits,mime,files,responses,payload}.ts`.
- Split voice ASR/auth/PCM and helper builds into `extensions/voice/asr.ts` and `extensions/voice/helpers.ts`.
- Pi entrypoints are unchanged: `extensions/meta.ts`, `extensions/media.ts`, `extensions/voice.ts`.
- Document that the catalog cache is written during interactive/RPC startup and after `/login meta`. `pi --list-models meta` lists models but does not trigger a network catalog refresh.

[Unreleased]: https://github.com/BlockedPath/pi-meta-oauth/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/BlockedPath/pi-meta-oauth/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/BlockedPath/pi-meta-oauth/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/BlockedPath/pi-meta-oauth/compare/v0.4.4...v0.5.0
[0.4.4]: https://github.com/BlockedPath/pi-meta-oauth/compare/v0.4.3...v0.4.4

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

All of the below was measured on 2026-10-11 with a live Muse Model API key against `api.meta.ai` and a live pi 1.1.0 host.

### Changed

- The extension no longer writes `~/.pi/agent/models-store.json`. That entry belongs to pi's `withRemoteCatalog()`, which persists `{models, checkedAt, lastModified, etag}`, validates with `if-none-match`/304 and discards a stored entry older than its bundled catalog. Our write carried neither `lastModified` nor `etag`: pi's `remoteModels()` ignored the models we stored, and we clobbered pi's entry, so the meta catalog was re-downloaded in full on every networked refresh. `persistMetaModels()` and `modelsForStore()` are gone; `refreshMetaModels()` only reads `context.stored` / `context.store.read()` and returns a list for pi to publish in memory. Verified live: a seeded pi.dev-shaped entry (`lastModified` + `etag` + a distinctive name and cost on `muse-spark-1.3`) survived a real session byte-for-byte, same md5.
- `composeMetaModels(base)` merges instead of choosing one source. Existence: the catalog fetched from Meta with this key when this process has one (authoritative for what the key can reach, which is what hides public ids that would 404), otherwise pi's own rows, otherwise the bundled pins. Metadata: for an id both sides know, pi's row wins over our derived defaults, so upstream price and limit updates reach us. Wire settings: `withMetaWireSettings()` re-applies our measurements to rows we do not own — pi's catalog entries carry no `compat` block at all, so without this a republished pi row would lose `supportsStrictMode`, and it forces the two measured absolutes (`supportsToolSearch: false`, because Meta accepts and ignores `tool_search_call`/`tool_search_output`; `thinkingLevelMap.off: null`, because Meta rejects `reasoning.effort: none`).
- `startLiveCatalogRefresh()` re-registers with `composeMetaModels([])` rather than the raw fetched rows, so the re-registered list carries the same wire settings as every later refresh. `registerProvider()` merges by key, so `models` has to be present: an omitted key would keep the previous value.
- `oauth.modifyModels()` was evaluated and deliberately not used: its docstring in every host from 0.83.0 to 1.1.0 labels it "Legacy synchronous credential-dependent model projection", and `composeModelProvider` only calls it when `context.credential?.type === "oauth"`, so env-key and `api_key`-credential users would never receive the wire settings. `refreshModels` is the documented seam, gets pi's rows through `context.stored`, and runs for both credential shapes.

- Pins aligned with pi 1.1.0's generated Meta catalog (identical in the bundle and at `https://pi.dev/api/models/providers/meta`, last-modified 2026-10-09): `maxTokens` 256000 → 131072, and the missing `inputLimits.images.resize` box (2000×2000, 4718592 bytes, JPEG 80) is now set on every model, so pi downscales images instead of forwarding full-size ones. This matters because the extension's `models` array *replaces* pi's list for provider `meta` (`composeModelProvider()` → `applyExtension()`), so anything pi measured and we omit is lost — and after the merge refactor below, pi's own row still wins for ids both sides know.
- The live prompt-cache probe resolves its model through `fetchMetaCatalog()` (filtered, IPv4-aware) instead of the raw `data[0].id`, tolerates up to 5 consecutive gateway 404s, and allows three attempts for a cache hit since the gateway load-balances across backends.

### Added

- `composeMetaModels()` and tests: pi's metadata merged into the ids Meta lists, a fetched catalog hiding ids the key cannot reach, pi's rows kept (with a compat block they lacked) when no live catalog is available, and no write/publish reaching pi's store on either the 0.83 `store` shape or the 0.84+ `stored` + `publish` shape. `bun test` → 90 pass / 1 skip / 0 fail.

- `isChatCatalogId()`, `isKnownMetaModelId()`, `markMetaModelNotFound()`, `clearMetaModelNotFound()`, `FLAKY_NOT_FOUND_META_RETRY`, `metaCatalogIPv4Enabled()` and the `setMetaCatalogIPv4Fetcher()` test seam.
- Tests: the 2026-10-11 catalog snapshot (8 rows → 5 chat ids), internal ids surviving the filter, store-restore filtering, pin parity with pi 1.1.0, six hermetic IPv4-fallback cases, 404 classification for known vs unknown ids, wire-level recovery from a flaky 404, the deeper 404 budget and exhaustion, an injected config honored verbatim, and a delivered turn clearing the fail-fast mark. `bun test` → 90 pass / 1 skip / 0 fail.
- Live verification while `api.meta.ai` oscillated between healthy and hard windows: in a window where 3 of 6 raw requests 404'd, 6 of 6 plugin turns succeeded and absorbed 3 transient 404s (one turn took 3 attempts); in a hard window (16/16 raw 404s) the first turn retried and failed, then later turns failed in ~150ms each instead of hanging 14s; 4 of 4 `pi -p` turns answered `pong`; a tool turn produced a real `toolCall get_weather({"city":"Tbilisi"})` with `stopReason: "toolUse"`; the live prompt-cache probe reported 3043/3068 cached tokens; and a session start left `models-store.json` byte-identical (same md5) with a seeded pi.dev-shaped entry inside it, proving the extension no longer writes pi's store.

### Fixed

- A flaky gateway 404 no longer kills a turn. Meta's `/v1/responses` intermittently answers HTTP 404 `{"code":"model_not_found"}` for a model the key really can reach: 5 of 12 identical raw requests and 2 of 12 plugin-level turns, on both IPv4 and IPv6, with the next attempt succeeding; 2 of 3 real `pi -p` sessions failed with it. `model_not_found` was in the non-transient set checked first, so the retry layer gave up immediately. `isRetryableMetaError()` now takes a `knownModel` verdict (third argument, derived from `message.model` when omitted) and retries a 404 only for an id `isKnownMetaModelId()` vouches for — this process's fetched `liveCatalog` when there is one (authoritative, so a retired id stops being retried), otherwise the bundled pins. A typo'd or unentitled id still fails fast.
- A 404 that burns every retry calls `markMetaModelNotFound(key, model)`, so later turns for that pair fail fast after a single attempt instead of paying the backoff again. Scoped per API key, dropped by `clearMetaModelNotFound()` as soon as a turn delivers content (so gateway recovery is immediate rather than waiting out a blind window), expiring after 5 minutes as a safety net, and cleared by `resetCatalogRefreshState()`.
- The flaky-404 class retries on its own budget, `FLAKY_NOT_FOUND_META_RETRY` (7 retries, 250ms→1s), instead of the 5xx ladder (3 retries, 2s→4s→8s). Meta answers a 404 in ~150ms without reaching the model, so a degraded window needs depth rather than distance: at the measured in-window success rate (~1 request in 6) four attempts cost a 14s hang and ~50% success, while eight attempts finish inside ~6s at ~77%. An injected `deps.config` still overrides both budgets verbatim.
- Non-chat catalog ids are no longer registered as chat models. A Muse key's `GET /v1/models` now returns 8 bare rows including `sam-3.1`, `muse-image-1.0` and `muse-voice-transcribe-1.0`; picking one in pi answered HTTP 400 ("SAM 3 requires an input_image or input_video content part in a user message") and the repo's own live cache probe failed on it, because it probed `data[0].id`. `toProviderModels()` drops the known non-chat families and any row whose declared input modalities exclude text, and `providerModelsFromStore()` filters the same way so a store written by an older build repairs itself on read. Unknown bare ids outside those families are kept, which is what account-scoped internal ids (`rl-muse-spark-1-3-sglang-playground`) rely on.
- Live catalog discovery works on dual-stack hosts. Meta's IPv6 edge answers `GET /v1/models` with HTTP 200 and `{"object":"list","data":[]}` (8/8 runs) while the IPv4 edge returns all 8 ids (8/8); `/v1/chat/completions` splits the same way (404 over IPv6, 200 over IPv4). Pi runs on Node, whose `fetch` prefers IPv6, so `startLiveCatalogRefresh()` always bailed at `models.length === 0`. `fetchMetaCatalog()` now retries once over a forced IPv4 `node:https` socket when the primary answer carries no models or failed at the transport level; HTTP status errors (401/403) are never retried. No dispatcher and no new dependency. `META_CATALOG_IPV4=0` disables it.

### Docs

- `AGENTS.md` gained a study of pi 1.1.0's built-in Meta provider: static pins plus a pi-hosted remote catalog (`withRemoteCatalog`, ETag, 4h), no `refreshModels`, no paste-a-key login, no `MODEL_API_KEY` fallback, and no `prompt_cache_retention` anywhere in the bundle. It also records why the extension no longer writes pi's `models-store.json` entry, how `composeMetaModels()` merges pi's rows with Meta's own catalog, and why `oauth.modifyModels()` was rejected as the seam (labelled "Legacy" in every host from 0.83.0 to 1.1.0, and only called for `type: "oauth"` credentials).

## [0.8.1] - 2026-10-06

### Changed

- pi 1.0.4 support re-measured, no code changes needed: the extension-API delta from 1.0.0 to 1.0.4 is additive (`registerToolRenderer`/`ToolRendererResolver`, `ToolLoadout.getPromptGuidelines`, optional `samplingParamsByThinkingLevel`; pi-ai added `resolveSamplingParams`, `refreshStoredOAuthCredential`, renamed the built-in `azure-openai-responses` provider id to `azure` and deprecated `hasToolRedefinitions` — none of which this extension touches). `devDependencies` pinned to pi/pi-ai 1.0.4 and `bun.lock` regenerated. Measured 2026-10-06: `bun run typecheck` clean (the repo's pinned TypeScript 5.9.3), `bun test` 70 pass / 2 skip (the live probes) / 0 fail, and `pi -ne -e <repo> --offline --list-models meta` prints the same 5 fallback ids.

## [0.8.0] - 2026-10-03

### Changed

- pi 1.0.0 support. pi 1.0.0 turned the legacy `ProviderConfig["models"]` element into a discriminated union — `ProviderChatModelConfig | ProviderImageModelConfig | ProviderClassifierModelConfig` (`dist/core/provider-composer.d.ts`) — and widened the persisted store entry to `readonly AnyModel[]` ("persisted models of every type"). `bun run typecheck` reported 12 errors here: chat-only fields (`reasoning`, `thinkingLevelMap`, `contextWindow`, `maxTokens`, `compat`) are no longer readable through the union, and `providerModelsFromStore` annotated store rows as `Model<Api>`, which an `ImageModel` is not. `MetaProviderModel` is now the chat member of that union and `createMetaProviderConfig()` returns `MetaProviderConfig` (same shape, `models` typed chat), so the tests read chat fields without casts; store rows are filtered with pi's own `isModelType(model, "chat")` instead of assuming every persisted entry is chat — a non-chat row has no `reasoning`/`contextWindow`/`maxTokens` to copy, and copying `undefined` would register a model that cannot stream. Coverage: `tests/meta.test.ts` adds a mixed-store case (one chat row plus one `type: "image"` row → only the chat id comes back), and mutation control — deleting the `isModelType` guard — turns exactly that test red. Measured 2026-10-03 against pi 1.0.0 / pi-ai 1.0.0: `bun run typecheck` clean (the repo's pinned TypeScript 5.9; the global 7.1.0-dev `tsc` on this machine cannot parse `bun-types/ts7.1/import-attributes.d.ts` at all, which is a toolchain artifact and not a code error), `bun test` 70 pass / 2 skip / 0 fail (was 69 before this case), and `pi -ne -e <repo> --offline --list-models meta` prints the same 5 fallback ids as on 0.86.1.
- Peer ranges widened to `>=0.83.0 <2.0.0` (was `<0.87.0`, which excluded the host everyone now runs) and devDependencies pinned to pi/pi-ai 1.0.0, so CI typechecks against the current host. The 0.83-era compatibility shims (`store` read/write vs `stored` + `publish`) are unchanged: the union and the mixed store are additive, and the code reads both shapes defensively.

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

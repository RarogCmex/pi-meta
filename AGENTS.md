# pi-meta-oauth — OAuth-only branch maintainer notes

## Branch contract

This branch intentionally ships only the Meta OAuth/provider extension:

- `package.json` registers only `extensions/meta.ts`.
- Do not add voice capture, media tools, slash commands, helper binaries, or platform-specific assets.
- Keep runtime dependencies limited to what `extensions/meta.ts` imports.

The extension owns the complete login/provider flow: Meta device authorization, identity-token polling, Model API-key minting and refresh, Muse model discovery, and provider request compatibility hints.

## OAuth flow

`/login meta` offers two methods: the device flow at `https://auth.meta.com` (default), or pasting a Model API key directly. The device flow exchanges the identity token through `POST https://api.meta.ai/muse-code/key`. Pi stores the identity token as `refresh`, the minted Model API key as `access`, and refreshes that key daily. Pasted keys are validated against `GET /v1/models`, stored with a `static-api-key:` prefix in `refresh`, and pass through `refreshToken` unchanged (no re-mint). Env keys (`META_API_KEY` / `MODEL_API_KEY`) keep working without login.

Keep both Pi refresh-context shapes working:

- Pi 0.83: mutable `store` read/write API
- Pi 0.84+: immutable `stored` snapshot plus generation-checked `publish`

Pi 0.86 never runs a networked catalog refresh inside a session
(`createAgentSessionServices()` builds its ModelRuntime without
`allowModelNetwork`, and extension-triggered live passes get superseded by the
startup refresh storm), and `pi update --models` does not load extensions — it
refreshes pi's built-in static Meta catalog instead. So `session_start` runs
`startLiveCatalogRefresh()`: fetch `GET /v1/models` with the resolved key,
store the result in the module-level `liveCatalog`, and re-register the
provider with the fetched ids. Offline refresh phases republish `liveCatalog`
and repair the persisted store when it diverges. This is what makes keys whose
account exposes only internal ids (e.g. `rl-muse-spark-1-3-sglang-playground`)
work; pi's built-in provider 404s on them.

Two catalog rules measured 2026-10-11 with a live Muse Model API key:

- **The catalog is no longer chat-only.** `GET /v1/models` returned 8 bare rows
  (`{id, object, created, owned_by}`, no `metadata["muse-code"]`):
  `sam-3.1`, `muse-image-1.0`, `muse-voice-transcribe-1.0` plus the five
  `muse-spark-*` ids. Registering them as chat models puts ids in pi's `/model`
  list that answer HTTP 400 ("SAM 3 requires an input_image or input_video
  content part in a user message"). `toProviderModels()` therefore drops
  `NON_CHAT_CATALOG_ID_RE` families and any row whose declared input
  modalities exclude text; `providerModelsFromStore()` applies the same filter
  so a store written by an older build repairs itself on read. Unknown bare ids
  outside those families are kept — that is the internal-id case above.
- **Meta's IPv6 edge returns an empty catalog.** From a dual-stack host,
  `curl -6` / Node `fetch` got HTTP 200 `{"object":"list","data":[]}` 8/8 runs
  while `curl -4` / Bun got all 8 ids 8/8; `/v1/chat/completions` splits the
  same way (404 over IPv6, 200 over IPv4). Pi runs on Node, so live discovery
  silently found nothing. `fetchMetaCatalog()` now retries once over a forced
  IPv4 `node:https` socket (`family: 4`, no dispatcher, no dependency) when the
  primary answer carries no models or failed at the transport level. HTTP status
  errors (401/403) are never retried. `META_CATALOG_IPV4=0` disables it;
  `setMetaCatalogIPv4Fetcher()` is the hermetic test seam, and the retry only
  arms for the fetch identity this module saw at load time so stubbed tests
  never reach the network.

Pins must stay in step with pi's own generated catalog, because this
extension's `models` array *replaces* pi's list for provider `meta`
(`composeModelProvider()` → `applyExtension()` maps the extension's models over
the base list): anything pi measured and we omit is lost. pi 1.1.0's bundle and
`https://pi.dev/api/models/providers/meta` (last-modified 2026-10-09) both pin
`maxTokens: 131072` (we said 256000) and an `inputLimits.images.resize` box of
2000×2000 / 4718592 bytes / JPEG 80 (we had none, so pi forwarded full-size
images). Both now come from `DEFAULT_MAX_OUTPUT_TOKENS` / `SPARK_INPUT_LIMITS`,
and `tests/meta.test.ts` asserts the parity.

Wire compatibility (measured 2026-09-20 against `api.meta.ai/v1/responses`):

- `compat.supportsStrictMode: true` — Meta accepts `strict: true` tools when the schema carries `additionalProperties: false`, which pi 0.86's strict converter always adds.
- `compat.supportsToolSearch: false` — Meta accepts but ignores `tool_search_call`/`tool_search_output`; a tool announced only through them is never called. With this off, pi always sends the full current tool list.
- `input: ["text", "image"]` — bare catalog entries answer image input; pi-ai types `Model.input` as text|image through 0.86, so do not re-add the video/audio cast.
- Reasoning effort supports `minimal|low|medium|high|xhigh` (and `max` only on some ids); `none` and `off` are rejected — keep `thinkingLevelMap.off: null` and the `reasoning.effort: none` strip in `applyMetaResponsesCacheHints()`.
- `prompt_cache_retention: "24h"` is accepted and produces cache hits, but Meta does not echo it; do not advertise `promptCache` lifetimes (cache warming would guess a cadence).

Hermetic OAuth and catalog tests live in `tests/meta.test.ts`.

## pi 1.1.0's built-in Meta provider (measured 2026-10-11)

Upstream ships Meta as **static pins plus a pi-hosted remote catalog**, with no
call to Meta's own `/v1/models` anywhere:

- `metaProvider()` = `createProvider({ id: "meta", baseUrl:
  "https://api.meta.ai/v1", auth: { apiKey: envApiKeyAuth(["META_API_KEY"]),
  oauth: lazyOAuth(metaOAuth) }, models: Object.values(META_MODELS), api:
  openAIResponsesApi() })`. **No `refreshModels`** — the model list never asks
  Meta anything.
- `metaOAuth` (`dist/bundle/chunks/meta.js`) is the same device flow we
  implement (`auth.meta.com` + `POST api.meta.ai/muse-code/key`, 24h key
  lifetime, 30s request timeout). It has **no paste-an-API-key path** and no
  `MODEL_API_KEY` env fallback — both stay ours.
- Every builtin provider except radius is wrapped in `withRemoteCatalog()`,
  which fetches `https://pi.dev/api/models/providers/<id>?types=chat,image,
  classifier` with `if-none-match`, a 4h interval
  (`REMOTE_CATALOG_REFRESH_INTERVAL_MS`), and persists
  `{models, checkedAt, lastModified, etag}` to `models-store.json`.
  `remoteModels()` discards a stored entry whose `lastModified` is older than
  the bundled catalog's `generatedAt`, so fresh pins win over a stale download.
- pi never emits `prompt_cache_retention` (zero hits in the 1.1.0 bundle) and
  `compat.supportsLongCacheRetention` is only schema-validated, never read;
  `cacheRetention` drives cache *warming* through `model.promptCache[retention]`.
  Our `before_provider_request` hook is still the only thing that turns 24h
  retention on, and we still must not advertise `promptCache` lifetimes.

Consequences for this extension:

1. Our `models` array replaces pi's pins, so pin drift is a real regression
   surface (see the parity rule above).
2. Our `persistMetaModels()` writes the same `models-store.json` entry under
   provider `meta` **without** `lastModified`/`etag`. Pi's `remoteModels()`
   ignores such an entry, and our write clobbers pi's — so pi re-downloads the
   meta catalog in full every networked refresh and its 304 path is dead for
   this provider. Harmless today (same 5 ids), but it is contention.
3. The only thing our live fetch adds over pi's mechanism is account-scoped ids
   pi.dev cannot know (`rl-muse-spark-*`). Everything else — pricing, limits,
   new public ids — pi's catalog service already delivers, and better.

Direction if this is revisited: keep the pins aligned with pi's, stop
persisting, and move discovery from `models` + `refreshModels` to the additive
`oauth.modifyModels(models, credential)` seam (`composeModelProvider` calls it
with the fully composed base list whenever an OAuth credential is present, and
our pasted-key login is stored as `type: "oauth"`). That appends discovered
account-scoped ids without discarding pi's catalog and without touching the
shared store. Not done yet: it changes registration shape on 0.83–1.0.x hosts
that the current compatibility shims cover.

## Verifying with a live key

`secret.env` (git-ignored) holds `URL=` and `KEY=` for a Muse Model API key. The
key is also the `meta` entry in `~/.pi/agent/auth.json`, so `bun test` runs the
live cache probe without any env. Checks that were run on 2026-10-11:

- `bun test` → 87 pass / 1 skip / 0 fail, including the live prompt-cache probe
  (3043/3068 tokens cached on the second identical call).
- `pi -p -ne -e ./extensions/meta.ts --model meta/muse-spark-1.3` → 4/4 `pong`
  (was 1/3 before the 404 fix).
- Tool calling through `streamSimple` → a real `toolCall`
  `get_weather({"city":"Tbilisi"})`, `stopReason: "toolUse"`.
- `pi --list-models meta` → the 5 chat ids at 131.1K max-out, no `sam-3.1`.
- After a session start, `models-store.json` carries the live catalog order
  (`muse-spark-1.3-contributor` first) with `maxTokens: 131072` and
  `inputLimits` — proof that discovery ran under Node via the IPv4 retry.

## Transparent error handling

`api.meta.ai` answers a flooded or slow request with HTTP 5xx — most often 504
`gateway_timeout` ("The response stream did not start before the server
timeout") — and pi-ai folds that into a terminal `stopReason: "error"` turn.
Pi's provider retry runs with `retry.provider.maxRetries` (often 0), and the
agent-level retry is visible to the model through retry extensions, so a short
gateway hiccup used to surface as a failed turn plus a model-visible
"Retry the previous request." message.

The extension absorbs that class of error at the provider seam, the same way
`pi-nvidia-plus` does at the undici transport: `createMetaProviderConfig()`
registers `streamSimple`, which re-issues the same context and options until a
usable stream starts, and pi only ever sees the final outcome. No undici
dispatcher, no extra runtime dependency.

- `isRetryableMetaError()` — non-transient text is checked FIRST
  (`encrypted_content`, auth, quota/billing, content filters, bad requests,
  context overflow), then pi-ai's `isRetryableAssistantError` catalog, then
  Meta/gateway wordings (`gateway_timeout`, `did not start before the server
  timeout`, `ResourceExhausted`, overload). One non-transient pattern has an
  exception: `model_not_found` for an id `isKnownMetaModelId()` vouches for IS
  retried, because Meta's gateway flakes it. Measured 2026-10-11 against
  `/v1/responses` with a valid key and `muse-spark-1.3`: 5/12 identical raw
  requests and 2/12 plugin-level turns answered HTTP 404 `model_not_found` on
  both IPv4 and IPv6, and the next attempt succeeded; 2 of 3 real `pi -p`
  sessions failed before the fix. "Known" means present in this process's
  `liveCatalog` when one was fetched (the catalog is authoritative, so a retired
  id stops being retried), otherwise present in `FALLBACK_MODELS`. A typo'd or
  unentitled id is never retried.
- An attempt that already delivered content to pi is never replayed: events are
  buffered until the first content-bearing one, so a failed 504 (which never
  starts the stream) is invisible in the transcript and a partial answer is
  surfaced unchanged.
- Backoff is exponential (`minDelayMs * 2^(attempt-1)`, cap `maxDelayMs`) and
  abortable during the wait; an abort there is reported as an aborted turn. The
  flaky-404 class runs on its own budget, `FLAKY_NOT_FOUND_META_RETRY` (7
  retries, 250ms→1s): Meta answers it in ~150ms without reaching the model, so
  a degraded window needs depth rather than distance — 4 attempts at 2s→4s→8s
  is a 14s hang with ~50% success where 8 attempts inside ~6s reach ~77%.
  `deps.config` overrides both budgets verbatim (test/tuning seam).
- On exhaustion pi gets the original error byte-for-byte, so behavior without
  the layer is preserved. `META_TRANSPORT_RETRY=0` disables it entirely.
- Three learnings ride along: an `encrypted_content` denial marks the (key,
  model) as unentitled so later requests strip the include, a `model_not_found`
  turn kicks a cooldown-guarded live-catalog repair, and a 404 that burned every
  retry calls `markMetaModelNotFound(key, model)` so later turns fail fast after
  a single attempt instead of paying the backoff again. The mark is written for
  any id that was considered known (`attempt > 1` gate keeps typos out), and
  `clearMetaModelNotFound()` drops it as soon as a turn delivers content, so
  recovery is immediate and `NOT_FOUND_BACKOFF_MS` (5 min) is only a safety net
  for a session that never asks again.
- Measured live 2026-10-11 while `api.meta.ai` oscillated between healthy and
  hard windows: in a window where 3 of 6 raw requests 404'd, 6 of 6 plugin
  turns still succeeded, absorbing 3 transient 404s (one turn took 3 attempts);
  in a hard window (16/16 raw 404s) the first turn retried and failed, and the
  following turns failed in ~150ms each instead of hanging 14s.

Wire-level, end-to-end retry coverage lives in `tests/meta-retry.test.ts`
(scripted inner Responses implementation, no network). It asserts the measured
504 body is absorbed, a flaky 404 recovers for a known id and never retries for
an unknown one, exhaustion marks the id unreachable and forwards the original
error byte-for-byte, content-bearing attempts are never replayed, quota 429s and
overflow never retry, and the stream contract holds when the inner API throws.

## Prompt caching

Muse Spark on `api.meta.ai` returns no useful cache hits on `/v1/chat/completions`. Keep the provider on `/v1/responses` and preserve `applyMetaResponsesCacheHints()` in the `before_provider_request` hook. It sets `prompt_cache_retention: "24h"` only when the payload has no explicit retention and removes `reasoning` when effort is `"none"` or missing because Meta rejects that shape.

`tests/meta-cache.test.ts` contains hermetic wire-contract coverage plus an optional live cache probe. The live probe resolves a key from `PI_META_LIVE_API_KEY`, `META_API_KEY`, `MODEL_API_KEY`, or an unexpired `meta.key` (api-key shape) / `meta.access` (oauth shape) entry in `~/.pi/agent/auth.json`, and picks its probe model from the live catalog because account-scoped keys may not expose `muse-spark-*` ids. It makes real billable requests whenever a credential resolves; do not put a live key in CI.

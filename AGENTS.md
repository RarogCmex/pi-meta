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

Wire compatibility (measured 2026-09-20 against `api.meta.ai/v1/responses`):

- `compat.supportsStrictMode: true` — Meta accepts `strict: true` tools when the schema carries `additionalProperties: false`, which pi 0.86's strict converter always adds.
- `compat.supportsToolSearch: false` — Meta accepts but ignores `tool_search_call`/`tool_search_output`; a tool announced only through them is never called. With this off, pi always sends the full current tool list.
- `input: ["text", "image"]` — bare catalog entries answer image input; pi-ai types `Model.input` as text|image through 0.86, so do not re-add the video/audio cast.
- Reasoning effort supports `minimal|low|medium|high|xhigh` (and `max` only on some ids); `none` and `off` are rejected — keep `thinkingLevelMap.off: null` and the `reasoning.effort: none` strip in `applyMetaResponsesCacheHints()`.
- `prompt_cache_retention: "24h"` is accepted and produces cache hits, but Meta does not echo it; do not advertise `promptCache` lifetimes (cache warming would guess a cadence).

Hermetic OAuth and catalog tests live in `tests/meta.test.ts`.

## Prompt caching

Muse Spark on `api.meta.ai` returns no useful cache hits on `/v1/chat/completions`. Keep the provider on `/v1/responses` and preserve `applyMetaResponsesCacheHints()` in the `before_provider_request` hook. It sets `prompt_cache_retention: "24h"` only when the payload has no explicit retention and removes `reasoning` when effort is `"none"` or missing because Meta rejects that shape.

`tests/meta-cache.test.ts` contains hermetic wire-contract coverage plus an optional live cache probe. The live probe resolves a key from `PI_META_LIVE_API_KEY`, `META_API_KEY`, `MODEL_API_KEY`, or an unexpired `meta.key` (api-key shape) / `meta.access` (oauth shape) entry in `~/.pi/agent/auth.json`, and picks its probe model from the live catalog because account-scoped keys may not expose `muse-spark-*` ids. It makes real billable requests whenever a credential resolves; do not put a live key in CI.

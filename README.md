<img width="3840" height="2160" alt="Meta-Symbol" src="https://github.com/user-attachments/assets/a3074df9-ad80-40ca-b9b9-944b96dda192" />

# pi-meta-oauth

<!-- markdownlint-disable-next-line MD013 -->
![X (formerly Twitter) Follow](https://img.shields.io/twitter/follow/blockedpaths?style=flat&link=https%3A%2F%2Fx.com%2FBlockedPaths)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![GitHub stars](https://img.shields.io/github/stars/BlockedPath/pi-meta-oauth?style=social)](https://github.com/BlockedPath/pi-meta-oauth/stargazers) [![Last Commit](https://img.shields.io/github/last-commit/BlockedPath/pi-meta-oauth)](https://github.com/BlockedPath/pi-meta-oauth/commits/main) [![Issues](https://img.shields.io/github/issues/BlockedPath/pi-meta-oauth)](https://github.com/BlockedPath/pi-meta-oauth/issues) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/BlockedPath/pi-meta-oauth/pulls) [![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://www.conventionalcommits.org/en/v1.0.0/) [![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)](https://www.typescriptlang.org/) [![CI](https://github.com/BlockedPath/pi-meta-oauth/actions/workflows/ci.yml/badge.svg)](https://github.com/BlockedPath/pi-meta-oauth/actions/workflows/ci.yml) [![Pi compatible](https://img.shields.io/badge/pi-Compatible-blueviolet)](https://pi.dev)

Meta Model API OAuth for [pi](https://pi.dev).

- Use Muse Spark models through Pi's `openai-responses` provider (not `/chat/completions` — Muse prompt cache is ~0% there)
- Send `prompt_cache_retention: "24h"` on Meta Responses requests unless the payload already set a retention
- Device authorization against `https://auth.meta.com`
- Model API-key minting through `POST https://api.meta.ai/muse-code/key`
- Live Muse catalog discovery from `GET https://api.meta.ai/v1/models` on session start, so account-specific model ids work too
- Transparent retry of transient Meta gateway failures (504 `gateway_timeout`, overload, 5xx) below pi — the model never sees a retry nudge
- Strict JSON-schema tool sampling and subscription-aware usage reporting, matching pi 0.86's built-in Meta provider

Pi 0.86 added a built-in Meta provider, but it ships a static `muse-spark-*`
catalog. Keys whose account exposes different ids (for example
`rl-muse-spark-1-3-sglang-playground`) get HTTP 404 `model_not_found` from it.
This extension keeps working for those keys: it fetches your real catalog and
registers exactly the ids your key can reach.

## Install

```bash
# OAuth-only branch
pi install git:github.com/BlockedPath/pi-meta-oauth@meta-oauth-only

# Or from a local checkout
pi install /absolute/path/to/pi-meta-oauth

pi --list-models meta
```

## Login

```text
/login meta
```

Pi displays a device code, opens the Meta authorization flow, and mints a Model API key. Credentials are stored by Pi in `~/.pi/agent/auth.json` under provider `meta`:

```json
{ "meta": { "type": "oauth", "refresh": "<identity>", "access": "<MODEL_API_KEY>", "expires": 123 } }
```

The access key is re-minted daily.

### Login with an API key

`/login meta` first asks which method to use:

- **Browser login (Meta device flow)** — the flow described above
- **Paste a Model API key** — the key is validated against `GET /v1/models` and stored as-is

The API-key path stores a static marker in `refresh`, so the daily refresh
passes the key through unchanged instead of trying to re-mint it:

```json
{ "meta": { "type": "oauth", "refresh": "static-api-key:<MODEL_API_KEY>", "access": "<MODEL_API_KEY>", "expires": 123 } }
```

Environment keys also work without any login: set `META_API_KEY` (or
`MODEL_API_KEY`, which the extension shims onto `META_API_KEY`).

## Prompt caching and encrypted reasoning

Muse Spark on `api.meta.ai` returns no useful cache hits on
`/v1/chat/completions`, so this provider drives the Responses API and sets
`prompt_cache_retention: "24h"` on every request (unless the payload already
sets one) for 93–99% cache hits.

Cross-turn reasoning continuity needs `include: ["reasoning.encrypted_content"]`,
but not every key is entitled to it: keys minted through `/muse-code/key`
can answer HTTP 400 `reasoning \`encrypted_content\` was not issued to this
caller`, which fails the whole request. So the provider probes each key once
per process and model — a ~16-token `/v1/responses` call carrying the include
with `max_output_tokens: 16`, naming the model actually in use — and:

- **200** → the key is entitled: the include is kept, reasoning carries across turns;
- **400 mentioning `encrypted_content`** → the include is stripped on every request, so calls never 400;
- **anything else** (transient error) → treated as not entitled for safety, re-probed after a 5-minute cooldown.

The probe runs in the background on the first request for a given key and is
recached when the daily key rotation delivers a new key. If Meta changes
entitlement policy, a restart (or daily key rotation) picks it up.

## Transparent error handling

Meta's gateway answers a flooded or slow request with HTTP 5xx — most often
504 `gateway_timeout` ("The response stream did not start before the server
timeout") — which pi-ai turns into a terminal error turn:

```text
Error: meta API error (504): {"code":"gateway_timeout","message":"The response stream did not start before the server timeout.","param":null,"type":"server_error"}
```

Pi's provider retry runs with `retry.provider.maxRetries` (often 0), and the
agent-level retry is model-visible through retry extensions, so a short gateway
hiccup used to surface as a failed turn and a "Retry the previous request."
message the model mistakes for a real instruction.

The extension absorbs that class of error at the provider seam — the same
approach `pi-nvidia-plus` takes at the undici transport. `streamSimple`
re-issues the same context and options until a usable stream starts, and pi only
ever sees the final outcome.

What is retried:

- 5xx and gateway/upstream failures, `gateway_timeout`, "did not start before
the server timeout", overload/`ResourceExhausted`, rate limits (pi-ai's
transient catalog plus Meta wordings).

What is never retried:

- anything after content already reached pi (the partial answer is surfaced
unchanged, so nothing is duplicated);
- aborted turns;
- context overflow (compaction handles it);
- deterministic failures: `reasoning.encrypted_content` denials, auth,
quota/billing (`insufficient_quota`, `GoUsageLimitError`, `out of budget`),
content filters, bad requests, and `model_not_found` for an id nothing vouches
for (a typo, or a model Meta retired).

One 404 is the exception. Meta's gateway intermittently answers
`model_not_found` for a model the key really can reach — measured 2026-10-11
against `api.meta.ai/v1/responses` with a valid Muse key, which alternated
between healthy windows (12/12 and 40/40 requests fine) and hard ones (16/16,
then 10/10, then 9/10 identical requests answering 404 on both IPv4 and IPv6).
So a 404 for an id the live catalog (or, without one, the bundled pins) vouches
for *is* retried. If it survives all retries the (key, model) pair is marked
unreachable and later turns fail fast after a single attempt; the mark is
cleared by the next turn that delivers content, so recovery is immediate (the
5-minute expiry is only a safety net).

Backoff is exponential and abortable during the wait with `Esc` (reported as an
aborted turn):

- 5xx/gateway/overload: up to 3 retries, 2s → 4s → 8s, capped at 30s.
- flaky 404 `model_not_found`: up to 7 retries, 250ms → 1s. Meta answers it in
  ~150ms without reaching the model, so a degraded window needs depth rather
  than distance — 8 attempts inside ~6s instead of a 14s hang.

On exhaustion pi receives the original error unchanged. Retries and exhaustion
are surfaced as pi notifications when a UI is present.

Three learnings ride along: an `encrypted_content` denial marks the key/model as
unentitled so later requests strip the include, a `model_not_found` turn kicks a
cooldown-guarded live-catalog repair, and a 404 that burned every retry marks
the key/model unreachable until a turn succeeds again.

Disable with `META_TRANSPORT_RETRY=0` (also `false`, `no`, `off`).

## Models

Fallback models use a 1,048,576-token context window, up to 131,072 output tokens, text and image input (downscaled to 2000×2000 / 4.5 MB JPEG-80 before upload, matching pi's own pins), and reasoning levels `minimal`, `low`, `medium`, `high`, and `xhigh`. `muse-spark-1.3` also maps thinking `max` → `max`.

The fallback list covers the public Meta Model API ids (not OpenCode Zen `*-contributor-free`). When your key exposes different, account-specific ids, the live catalog discovered on session start decides which ids are offered:

> Meta's `/v1/models` is no longer chat-only: a Muse key's catalog (measured
> 2026-10-11) also lists `sam-3.1`, `muse-image-1.0` and
> `muse-voice-transcribe-1.0`. This extension registers chat models only, so
> those families are filtered out — asking one of them for text answers HTTP 400
> ("SAM 3 requires an input_image or input_video content part"). Unknown bare
> ids outside those families are kept, which is how account-scoped internal ids
> keep working.

| id | pricing (input/output/cached) $/M |
| --- | --- |
| `muse-spark-1.3` | 1.25 / 4.25 / 0.15 |
| `muse-spark-1.3-contributor` | 0.10 / 0.20 / 0.002 |
| `muse-spark-1.2` | 1.25 / 4.25 / 0.15 |
| `muse-spark-1.2-contributor` | 0.10 / 0.20 / 0.002 |
| `muse-spark-1.1` | 1.25 / 4.25 / 0.15 |

> **Contributor-model privacy:** discounted contributor models allow Meta to use prompts and completions for product improvement, including training future Meta models. Use a standard model such as `muse-spark-1.3` if you do not want the contributor terms. See [Meta's model documentation](https://dev.meta.ai/docs/models).

To scope Pi's model picker to Meta models:

```json
{ "enabledModels": ["meta/*"] }
```

### Making context windows visible to external tools

Pi runs every in-session model refresh with `allowNetwork: false`, and the only
networked caller (`pi update --models`) does not load extensions. So this
extension fetches `GET /v1/models` itself on `session_start` (cooldown: 4h per
process, skipped under `PI_OFFLINE`) and re-registers the provider so the picker
and pi's model snapshot pick the ids up. The fetched catalog is kept in memory
and recomposed on every later refresh, including offline ones, so it is also
what Pi uses when it starts without network access.

The composed list is a merge, not a takeover:

- **existence** comes from Meta's catalog when this process fetched one (it is
  authoritative for what your key can reach, which is what hides public ids
  that would 404), otherwise from pi's own catalog rows, otherwise from the
  bundled pins;
- **metadata** for an id both sides know comes from pi's row — pi 1.1.0 refreshes
  every builtin provider from `https://pi.dev/api/models/providers/meta` with
  ETag/304 and a 4h interval, so upstream pricing and limits stay current;
- **wire settings** (compat flags, `thinkingLevelMap.off: null`, image resize
  limits) are always ours, including on rows we do not own: pi's catalog entries
  carry no `compat` block at all.

`~/.pi/agent/models-store.json` is pi's file and this extension no longer writes
it. It used to persist its own entry there, without the `lastModified`/`etag`
fields pi's remote catalog uses — pi ignored those models and the write
clobbered pi's entry, defeating its 304 path. External usage tools such as
[herdr-agent-usage](https://github.com/senna-lang/herdr-agent-usage) still get
context windows from pi's own entry.

> **IPv6 note:** measured 2026-10-11 from a dual-stack host, Meta's IPv6 edge
> answers `GET /v1/models` with HTTP 200 and an empty `data` array (8/8 runs)
> while the IPv4 edge returns the full catalog (8/8); `/v1/chat/completions`
> splits the same way (404 over IPv6, 200 over IPv4). Pi runs on Node, whose
> `fetch` prefers IPv6, so an empty (or transport-failed) catalog is retried once
> over a forced IPv4 `node:https` socket — no dispatcher, no dependency. An HTTP
> status error such as 401 is never retried. Disable with `META_CATALOG_IPV4=0`.

The bundled fallback uses Meta's nominal `1,048,576`-token context window. A
cached Muse Code 0.1.0/R708.1 catalog observed on 2026-08-06 reported a lower
effective limit of `1,007,997` for `muse-spark-1.2` and
`muse-spark-1.2-contributor`. If you need percentages to match that specific
Muse snapshot, you can still set `contextWindow: 1007997` for those models in
`~/.pi/agent/models.json`; model overrides take precedence over the composed
catalog.

## Verify

Host versions: verified against pi **1.0.0** (2026-10-03), pi **1.0.4** / pi-ai **1.0.4** (2026-10-06) and pi **1.1.0** / pi-ai **1.1.0** (2026-10-11, live key); `devDependencies` are pinned to 1.1.0, so CI typechecks against the current host. Measured: `bun run typecheck` clean (the repo's pinned TypeScript 5.9.3), `bun test` 90 pass / 1 skip / 0 fail, and `pi -ne -e <repo> --list-models meta` prints the five Spark chat ids at 131.1K max-out. The 1.0.4 → 1.1.0 API delta is additive on both sides (`durationMs`/`outputPad` on tool renderers, `aborted` on `agent_settled`; pi-ai added the `openai-decisions` classifier api) and touches nothing this provider uses. pi 1.1.0 wraps every builtin provider in a remote-catalog fetch from `https://pi.dev/api/models/providers/<id>` (ETag, 4h, persisted with `lastModified`), and its generated meta pins match ours field for field; its `metaProvider()` has no `refreshModels` and no paste-a-key login, so both remain reasons to use this extension. The 1.0.1–1.0.4 extension-API delta is additive and touches nothing this provider uses. pi 1.0.0 made the legacy model-list config a `chat | image | classifier` union and widened its persisted store to every model type; this extension registers chat only (`MetaProviderModel`, `MetaProviderConfig`) and drops non-chat rows when it re-reads pi's store. The same source also typechecks against the 0.86.x line, where those fields were not a union (measured before this change).

```bash
pi --list-models meta
pi -p --provider meta --model muse-spark-1.3 "Reply exactly: META_OK"
# account-specific ids from your live catalog work too, e.g.:
pi -p --provider meta --model rl-muse-spark-1-3-sglang-playground "Reply exactly: META_OK"
bun run typecheck
bun test
```

`bun test` is hermetic unless a Meta credential is already available. The live cache-hit probe makes real billable API calls when a credential resolves: two identical `/v1/responses` calls (asserting `cached_tokens` on the second), plus one 2s retry if that second call misses cache. The credential is resolved, in order, from `PI_META_LIVE_API_KEY`, `META_API_KEY`, `MODEL_API_KEY`, or the minted key from `~/.pi/agent/auth.json` after `/login meta` (skipped if expired). OAuth is enough — you do not need a separate key. Skipped when no valid credential exists (CI):

```bash
bun test tests/meta-cache.test.ts
# or, if you are not logged in:
PI_META_LIVE_API_KEY='LLM|...' bun test tests/meta-cache.test.ts
```

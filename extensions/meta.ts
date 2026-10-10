import type {
	AnyModel,
	Model,
	ModelsStoreEntry,
	OAuthCredentials,
	OAuthLoginCallbacks,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	isContextOverflow,
	isModelType,
	isRetryableAssistantError,
	openAIResponsesApi,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
} from "@earendil-works/pi-ai/compat";

export const META_PROVIDER_ID = "meta";
export const META_API_BASE_URL = "https://api.meta.ai/v1";
export const META_MODEL_CATALOG_URL = "https://api.meta.ai/v1/models";
export const META_AUTH_BASE_URL = "https://auth.meta.com";
export const META_CLIENT_ID = "1031625952748946";
const META_ENV_VAR = "META_API_KEY";

const DEVICE_AUTHORIZATION_URL = `${META_AUTH_BASE_URL}/oidc/device/authorization/`;
const DEVICE_TOKEN_URL = `${META_AUTH_BASE_URL}/oidc/device/token/`;
const API_KEY_MINT_URL = "https://api.meta.ai/muse-code/key";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const API_KEY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Pi 0.86 never runs a networked catalog refresh inside a session:
 * `createAgentSessionServices()` builds its ModelRuntime without
 * `allowModelNetwork`, and `registerProvider()` only triggers
 * `refresh({ allowNetwork: false })`. The one networked caller,
 * `pi update --models`, does not load extensions at all, so it refreshes the
 * built-in static Meta catalog instead of this one. Asking pi for a live
 * refresh from `session_start` does not help either: pi's startup fires
 * dozens of offline refreshes, and `Models.beginProviderRefresh()` supersedes
 * (aborts) an in-flight refresh of the same provider. The extension therefore
 * fetches the catalog itself and re-registers the provider; see
 * `startLiveCatalogRefresh()`.
 */
const CATALOG_REFRESH_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const CATALOG_REFRESH_TIMEOUT_MS = 20 * 1000;

/**
 * Marks credentials created by pasting a Model API key instead of the device
 * flow. The marker lives in `refresh` (OAuthCredentials requires one), so
 * refreshMetaToken can tell a static key from an identity token and must not
 * send it to the mint endpoint.
 */
export const STATIC_API_KEY_PREFIX = "static-api-key:";

/**
 * pi 1.0.0 turned the legacy `ProviderModelConfig` into a discriminated union
 * (chat | image | classifier), so the union no longer exposes `reasoning`,
 * `thinkingLevelMap`, `contextWindow`, `maxTokens` or `compat`. This provider
 * registers chat models only — Meta's `/v1/models` answers with chat ids and
 * the extension implements no image or classifier operation — so every model
 * list here is the chat member of that union. `type` stays optional: an entry
 * without it reads as chat on both sides of the API.
 */
export type MetaProviderModel = Extract<
	NonNullable<ProviderConfig["models"]>[number],
	{ type?: "chat" }
>;

/** The provider registration this extension produces: same shape, chat models. */
export type MetaProviderConfig = Omit<ProviderConfig, "models"> & {
	models?: MetaProviderModel[];
};
type Fetch = typeof fetch;
type Sleep = (milliseconds: number) => Promise<void>;

interface DeviceAuthorization {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
}

interface DeviceTokenGrant {
	access_token: string;
}

interface OAuthError {
	error?: string;
	error_description?: string;
}

interface MintResponse {
	api_key?: string;
	base_url?: string;
	require_payment?: boolean;
	action_url?: string;
}

interface CatalogResponse {
	data?: MetaCatalogModel[];
}

interface MetaCatalogModel {
	id?: string;
	metadata?: {
		"muse-code"?: {
			name?: string;
			is_hidden?: boolean;
			reasoning?: boolean;
			modalities?: { input?: string[] };
			limit?: { context?: number; output?: number };
			variants?: Record<string, { reasoningEffort?: string }>;
			cost?: {
				input?: string | number;
				output?: string | number;
				cached?: string | number;
			};
		};
	};
}

const PAID_COST = { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 };
const CONTRIBUTOR_COST = {
	input: 0.1,
	output: 0.2,
	cacheRead: 0.002,
	cacheWrite: 0,
};
const SPARK_THINKING: NonNullable<MetaProviderModel["thinkingLevelMap"]> = {
	off: null,
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: null,
};

/** Muse Spark is a vision model; the public catalog advertises text+image. */
const DEFAULT_INPUT: MetaProviderModel["input"] = ["text", "image"];

/**
 * Output-token ceiling and image limits, taken from pi 1.1.0's generated Meta
 * catalog (static pins, and `https://pi.dev/api/models/providers/meta`,
 * last-modified 2026-10-09 — both say `maxTokens: 131072` and the same resize
 * box). This extension's model list *replaces* pi's pins for provider `meta`
 * (`composeModelProvider()` → `applyExtension()` maps the extension's `models`
 * over the base list), so anything pi measured and we omit is lost: without
 * `inputLimits` pi sends full-size images to Meta instead of downscaling.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 131_072;
const SPARK_INPUT_LIMITS: NonNullable<MetaProviderModel["inputLimits"]> = {
	images: {
		resize: {
			maxWidth: 2_000,
			maxHeight: 2_000,
			maxBytes: 4_718_592,
			jpegQuality: 80,
		},
	},
};

/**
 * Meta's `/v1/models` is no longer chat-only. Measured 2026-10-11 with a Muse
 * Model API key, the live catalog lists `sam-3.1`, `muse-image-1.0` and
 * `muse-voice-transcribe-1.0` next to the five Spark chat ids — all as bare
 * entries with no `muse-code` metadata block. This provider registers chat
 * models only, and a non-chat id answers HTTP 400 ("SAM 3 requires an
 * input_image or input_video content part in a user message"), so the known
 * non-chat families are dropped. Unknown bare ids that are *not* in a denied
 * family stay: that is what keeps account-scoped internal chat ids such as
 * `rl-muse-spark-1-3-sglang-playground` working.
 */
const NON_CHAT_CATALOG_ID_RE =
	/(^|[-._])(sam|imagen|flux|emulator|whisper|tts|transcribe|transcription|image|images|video|audio|segment|ocr|embed|embedding|embeddings|rerank)([-._]|\d|$)/i;

/** True when a catalog id can be registered as a chat model. */
export function isChatCatalogId(modelId: string): boolean {
	return !NON_CHAT_CATALOG_ID_RE.test(modelId);
}

/**
 * Wire compatibility, measured against `api.meta.ai/v1/responses` on
 * 2026-09-20:
 * - `strict: true` function tools are accepted and constrained as long as the
 *   schema carries `additionalProperties: false`, which pi's strict converter
 *   always adds. Without this flag pi 0.86's default strict-prefer sampling
 *   for read/bash/edit/write never reaches Meta.
 * - `tool_search_call`/`tool_search_output` items are accepted but ignored:
 *   a tool announced only through them is never called, while the same tool
 *   in `tools` is. So tool search stays off and pi keeps sending the full
 *   current tool list, which also covers tools added mid-conversation.
 * - `prompt_cache_retention: "24h"` is accepted and produces cache hits, so
 *   long retention stays enabled. `promptCache` lifetimes are deliberately
 *   not advertised: Meta never echoes the retention it applied, so pi 0.86's
 *   cost-aware cache warming would fire on a guessed cadence.
 */
type MetaCompat = NonNullable<Model<"openai-responses">["compat"]>;
const SPARK_COMPAT: MetaCompat = {
	supportsLongCacheRetention: true,
	supportsStrictMode: true,
	supportsToolSearch: false,
};

function sparkModel(
	id: string,
	name: string,
	cost: MetaProviderModel["cost"],
	thinkingLevelMap: NonNullable<
		MetaProviderModel["thinkingLevelMap"]
	> = SPARK_THINKING,
): MetaProviderModel {
	return {
		id,
		name,
		reasoning: true,
		thinkingLevelMap,
		// pi-ai types Model.input as ("text" | "image")[] through 0.86; pi cannot
		// attach video or audio, so advertising them would only mislead gating.
		input: [...DEFAULT_INPUT],
		cost,
		contextWindow: 1_048_576,
		maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
		inputLimits: structuredClone(SPARK_INPUT_LIMITS),
		compat: { ...SPARK_COMPAT },
	};
}

const FALLBACK_MODELS: MetaProviderModel[] = [
	// Meta Model API ids only (not OpenCode Zen `*-contributor-free`).
	// 1.3 standard is the only Spark that maps thinking `max` → `max`.
	sparkModel("muse-spark-1.3", "Muse Spark 1.3", PAID_COST, {
		...SPARK_THINKING,
		max: "max",
	}),
	sparkModel(
		"muse-spark-1.3-contributor",
		"Muse Spark 1.3 Contributor",
		CONTRIBUTOR_COST,
	),
	sparkModel("muse-spark-1.2", "Muse Spark 1.2", PAID_COST),
	sparkModel(
		"muse-spark-1.2-contributor",
		"Muse Spark 1.2 Contributor",
		CONTRIBUTOR_COST,
	),
	sparkModel("muse-spark-1.1", "Muse Spark 1.1", PAID_COST),
];

export const DEFAULT_MUSE_MODEL = FALLBACK_MODELS[0].id;

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function responseBody(
	response: Response,
): Promise<Record<string, unknown>> {
	const text = await response.text();
	if (!text) return {};
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function errorDetail(body: Record<string, unknown>): string | undefined {
	for (const key of ["error_description", "detail", "message", "error"]) {
		const value = body[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

async function postForm<T>(
	url: string,
	fields: Record<string, string>,
	fetchImpl: Fetch,
): Promise<{ response: Response; body: T & Record<string, unknown> }> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(fields),
		redirect: "manual",
	});
	return {
		response,
		body: (await responseBody(response)) as T & Record<string, unknown>,
	};
}

function isAbortSignal(value: unknown): value is AbortSignal {
	return (
		typeof value === "object" &&
		value !== null &&
		"aborted" in value &&
		typeof (value as AbortSignal).aborted === "boolean"
	);
}

export async function mintMetaApiKey(
	identityToken: string,
	fetchImpl: Fetch = fetch,
	signal?: AbortSignal,
): Promise<string> {
	const response = await fetchImpl(API_KEY_MINT_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${identityToken}`,
			"Content-Type": "application/json",
			"x-api-version": "1.0.0",
		},
		body: "{}",
		signal,
	});
	const body = (await responseBody(response)) as MintResponse &
		Record<string, unknown>;
	if (!response.ok) {
		const detail = errorDetail(body);
		if (response.status === 401 || response.status === 403) {
			throw new Error(
				`Meta session expired (HTTP ${response.status}); run /login meta again${detail ? `: ${detail}` : ""}`,
			);
		}
		throw new Error(
			`Meta API-key mint failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
		);
	}
	if (typeof body.api_key !== "string" || !body.api_key) {
		const setup =
			typeof body.action_url === "string" && body.action_url
				? ` Complete setup at ${body.action_url}.`
				: "";
		throw new Error(`Meta did not issue an API key.${setup}`);
	}
	return body.api_key;
}

/**
 * API-key login: prompt for a Meta Model API key, validate it against the
 * model catalog, and store it as a static credential. No daily re-minting —
 * refreshMetaToken passes the key through unchanged.
 */
export async function loginMetaWithApiKey(
	callbacks: OAuthLoginCallbacks,
	fetchImpl: Fetch = fetch,
): Promise<OAuthCredentials> {
	const key = (
		await callbacks.onPrompt({ message: "Meta Model API key:" })
	).trim();
	if (!key) throw new Error("Meta login requires an API key");
	callbacks.onProgress?.("Validating Meta Model API key…");
	const response = await fetchImpl(META_MODEL_CATALOG_URL, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${key}`,
			"x-api-version": "1.0.0",
		},
	});
	if (!response.ok) {
		const detail = errorDetail(await responseBody(response));
		if (response.status === 401 || response.status === 403) {
			throw new Error(
				`Meta rejected the API key (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
			);
		}
		throw new Error(
			`Meta API key validation failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
		);
	}
	return {
		refresh: `${STATIC_API_KEY_PREFIX}${key}`,
		access: key,
		expires: Date.now() + API_KEY_REFRESH_INTERVAL_MS,
	};
}

export async function loginMeta(
	callbacks: OAuthLoginCallbacks,
	fetchImpl: Fetch = fetch,
	sleep: Sleep = delay,
): Promise<OAuthCredentials> {
	// Offer API-key login next to the device flow. Hosts without onSelect and
	// dismissed selectors (undefined) keep the original device-flow behavior.
	const method = await callbacks.onSelect?.({
		message: "Select Meta login method:",
		options: [
			{ id: "browser", label: "Browser login (Meta device flow)" },
			{ id: "api-key", label: "Paste a Model API key" },
		],
	});
	if (method === "api-key") {
		return loginMetaWithApiKey(callbacks, fetchImpl);
	}
	callbacks.onProgress?.("Starting Meta device authorization…");
	const authorization = await postForm<DeviceAuthorization>(
		DEVICE_AUTHORIZATION_URL,
		{ client_id: META_CLIENT_ID },
		fetchImpl,
	);
	if (!authorization.response.ok) {
		throw new Error(
			`Meta login could not be started (HTTP ${authorization.response.status})${errorDetail(authorization.body) ? `: ${errorDetail(authorization.body)}` : ""}`,
		);
	}
	const device = authorization.body;
	if (!device.device_code || !device.user_code || !device.verification_uri) {
		throw new Error("Meta device authorization returned an incomplete response");
	}

	let intervalSeconds =
		Number.isFinite(device.interval) && Number(device.interval) > 0
			? Number(device.interval)
			: 5;
	const expiresInSeconds =
		Number.isFinite(device.expires_in) && Number(device.expires_in) > 0
			? Number(device.expires_in)
			: 900;
	const deadline = Date.now() + expiresInSeconds * 1000;
	callbacks.onDeviceCode({
		userCode: device.user_code,
		verificationUri: device.verification_uri_complete || device.verification_uri,
		intervalSeconds,
		expiresInSeconds,
	});
	callbacks.onProgress?.("Waiting for Meta login approval…");

	let identityToken: string | undefined;
	while (Date.now() < deadline) {
		await sleep(intervalSeconds * 1000);
		const grant = await postForm<DeviceTokenGrant & OAuthError>(
			DEVICE_TOKEN_URL,
			{
				grant_type: DEVICE_CODE_GRANT,
				device_code: device.device_code,
				client_id: META_CLIENT_ID,
			},
			fetchImpl,
		);
		if (grant.response.ok && grant.body.access_token) {
			identityToken = grant.body.access_token;
			break;
		}
		switch (grant.body.error) {
			case "authorization_pending":
				continue;
			case "slow_down":
				intervalSeconds += 5;
				continue;
			case "access_denied":
				throw new Error("Meta login was denied");
			case "expired_token":
				throw new Error("Meta login request expired");
			default:
				throw new Error(
					`Meta login failed (HTTP ${grant.response.status})${errorDetail(grant.body) ? `: ${errorDetail(grant.body)}` : ""}`,
				);
		}
	}
	if (!identityToken) throw new Error("Meta login request expired");

	callbacks.onProgress?.("Enabling Meta Model API access…");
	const apiKey = await mintMetaApiKey(identityToken, fetchImpl);
	return {
		refresh: identityToken,
		access: apiKey,
		expires: Date.now() + API_KEY_REFRESH_INTERVAL_MS,
	};
}

export async function refreshMetaToken(
	credentials: OAuthCredentials,
	fetchOrSignal: Fetch | AbortSignal = fetch,
): Promise<OAuthCredentials> {
	if (credentials.refresh?.startsWith(STATIC_API_KEY_PREFIX)) {
		// Static API-key login: nothing to re-mint; keep the key, roll expiry.
		return {
			...credentials,
			access:
				credentials.refresh.slice(STATIC_API_KEY_PREFIX.length) ||
				credentials.access,
			expires: Date.now() + API_KEY_REFRESH_INTERVAL_MS,
		};
	}
	if (!credentials.refresh)
		throw new Error(
			"Meta login is missing its identity token; run /login meta again",
		);
	// Pi 0.83 calls refreshToken(credentials). Pi 0.84 passes AbortSignal as
	// the second argument. Tests inject a fetch mock in that slot.
	const fetchImpl = typeof fetchOrSignal === "function" ? fetchOrSignal : fetch;
	const signal = isAbortSignal(fetchOrSignal) ? fetchOrSignal : undefined;
	if (signal?.aborted) {
		throw new Error("Meta token refresh was cancelled");
	}
	return {
		...credentials,
		access: await mintMetaApiKey(credentials.refresh, fetchImpl, signal),
		expires: Date.now() + API_KEY_REFRESH_INTERVAL_MS,
	};
}

function finitePositive(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function numericCost(value: unknown, fallback: number): number {
	const number =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number(value)
				: Number.NaN;
	return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function displayName(id: string): string {
	return id
		.split(/[-_. ]+/)
		.filter(Boolean)
		.map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
		.join(" ");
}

function catalogDisplayName(raw: unknown, id: string): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (trimmed.toLowerCase() === id.toLowerCase()) return undefined;
	return trimmed;
}

function modalitiesToInput(
	modalities: string[] | undefined,
	fallback: MetaProviderModel["input"] | undefined,
): MetaProviderModel["input"] {
	if (!modalities)
		// Bare catalog entries (no metadata block) are the common Meta case;
		// Muse Spark answers image input on them, measured 2026-09-20.
		return fallback ?? [...DEFAULT_INPUT];
	const input: MetaProviderModel["input"] = ["text"];
	if (modalities.includes("image")) input.push("image");
	return input;
}

export function toProviderModels(
	catalog: CatalogResponse,
): MetaProviderModel[] {
	const seen = new Set<string>();
	return (catalog.data ?? []).flatMap((entry) => {
		if (typeof entry.id !== "string" || !entry.id) return [];
		if (seen.has(entry.id)) return [];
		seen.add(entry.id);
		const metadata = entry.metadata?.["muse-code"];
		if (metadata?.is_hidden) return [];
		// Chat-only provider: drop Meta's image/segmentation/transcription ids.
		if (!isChatCatalogId(entry.id)) return [];
		const modalities = metadata?.modalities?.input;
		if (
			Array.isArray(modalities) &&
			modalities.length > 0 &&
			!modalities.includes("text")
		)
			return [];
		const fallback = FALLBACK_MODELS.find((model) => model.id === entry.id);
		const catalogName = catalogDisplayName(metadata?.name, entry.id);
		const variants = metadata?.variants ?? {};
		const thinkingLevelMap: NonNullable<MetaProviderModel["thinkingLevelMap"]> = {
			off: null,
			minimal: variants.minimal?.reasoningEffort ?? "minimal",
			low: variants.low?.reasoningEffort ?? "low",
			medium: variants.medium?.reasoningEffort ?? "medium",
			high: variants.high?.reasoningEffort ?? "high",
			xhigh: variants.xhigh?.reasoningEffort ?? "xhigh",
			max:
				variants.max?.reasoningEffort ?? fallback?.thinkingLevelMap?.max ?? null,
		};
		return [
			{
				id: entry.id,
				name: catalogName || fallback?.name || displayName(entry.id),
				reasoning: metadata?.reasoning ?? fallback?.reasoning ?? true,
				thinkingLevelMap,
				input: modalitiesToInput(modalities, fallback?.input),
				cost: {
					input: numericCost(metadata?.cost?.input, fallback?.cost.input ?? 0),
					output: numericCost(metadata?.cost?.output, fallback?.cost.output ?? 0),
					cacheRead: numericCost(
						metadata?.cost?.cached,
						fallback?.cost.cacheRead ?? 0,
					),
					cacheWrite: 0,
				},
				contextWindow: finitePositive(
					metadata?.limit?.context,
					fallback?.contextWindow ?? 1_048_576,
				),
				maxTokens: finitePositive(
					metadata?.limit?.output,
					fallback?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
				),
				inputLimits: structuredClone(
					fallback?.inputLimits ?? SPARK_INPUT_LIMITS,
				),
				compat: { ...SPARK_COMPAT },
			} satisfies MetaProviderModel,
		];
	});
}

interface CatalogStore {
	read(): Promise<ModelsStoreEntry | undefined>;
	write(entry: ModelsStoreEntry): Promise<void>;
}

interface CompatibleRefreshContext {
	credential?: RefreshModelsContext["credential"];
	allowNetwork: boolean;
	signal?: AbortSignal;
	// Pi 0.83 catalog persistence API.
	store?: CatalogStore;
	// Pi 0.84 generation-checked catalog persistence API.
	stored?: Readonly<ModelsStoreEntry>;
	publish?(publication: { persist?: ModelsStoreEntry | null }): Promise<boolean>;
}

function providerModelsFromStore(
	entry: Readonly<ModelsStoreEntry> | undefined,
): MetaProviderModel[] {
	const seen = new Set<string>();
	// pi 1.0.0 persists models of every operation in one entry (`readonly
	// AnyModel[]`), so a store written by a future build can carry image or
	// classifier ids here. This provider only knows chat, and a non-chat entry
	// has no `reasoning`/`contextWindow`/`maxTokens` to copy — drop those.
	return (entry?.models ?? []).flatMap((model: AnyModel) => {
		if (!isModelType(model, "chat")) return [];
		// A store written before the non-chat filter can still carry `sam-3.1`
		// and friends as chat rows; dropping them here repairs it on read.
		if (!isChatCatalogId(model.id)) return [];
		if (model.provider !== META_PROVIDER_ID || model.api !== "openai-responses")
			return [];
		if (typeof model.id !== "string" || !model.id || seen.has(model.id)) return [];
		seen.add(model.id);
		const name =
			typeof model.name === "string" && model.name.trim()
				? model.name.trim()
				: displayName(model.id);
		return [
			{
				id: model.id,
				name,
				api: model.api,
				baseUrl: model.baseUrl,
				reasoning: model.reasoning,
				thinkingLevelMap: model.thinkingLevelMap,
				input: model.input as MetaProviderModel["input"],
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				inputLimits: model.inputLimits ?? structuredClone(SPARK_INPUT_LIMITS),
				headers: model.headers,
				compat: model.compat as MetaProviderModel["compat"],
			},
		];
	});
}

async function cachedMetaModels(
	context: CompatibleRefreshContext,
): Promise<MetaProviderModel[]> {
	try {
		const stored = context.stored ?? (await context.store?.read());
		return providerModelsFromStore(stored);
	} catch {
		// Reading the shared store is best-effort; bundled pins remain available.
		return [];
	}
}

/**
 * Apply this extension's measured wire settings to a model row we do not own
 * (pi's static pin, or a row from pi's `https://pi.dev` remote catalog, which
 * arrives without a `compat` block). Upstream values win wherever we have
 * nothing better to say; the two forced fields are measurements, not opinions:
 * Meta ignores `tool_search_call`/`tool_search_output` (so a tool announced
 * only through them is never called) and rejects `reasoning.effort: none`.
 */
function withMetaWireSettings(model: MetaProviderModel): MetaProviderModel {
	return {
		...model,
		reasoning: model.reasoning ?? true,
		thinkingLevelMap: {
			...SPARK_THINKING,
			...model.thinkingLevelMap,
			off: null,
		},
		input:
			model.input && model.input.length > 0
				? model.input
				: [...DEFAULT_INPUT],
		inputLimits: model.inputLimits ?? structuredClone(SPARK_INPUT_LIMITS),
		contextWindow: finitePositive(model.contextWindow, 1_048_576),
		maxTokens: finitePositive(model.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS),
		compat: {
			supportsLongCacheRetention: true,
			supportsStrictMode: true,
			...model.compat,
			supportsToolSearch: false,
		},
	};
}

/**
 * Build the chat list this extension wants pi to serve for provider `meta`.
 *
 * Existence: a catalog fetched from Meta with this key is authoritative — that
 * is what surfaces account-scoped internal ids and hides public ids the key
 * cannot reach. Without one, pi's own rows (static pins merged with the
 * `pi.dev` remote catalog, as persisted in `models-store.json`) win if present,
 * and the bundled pins are the last resort.
 *
 * Metadata: for an id both sides know, pi's row wins over our derived defaults
 * (upstream re-measures pricing and limits continuously), and
 * `withMetaWireSettings()` puts our compat/thinking/image limits back on top.
 *
 * Nothing here writes `models-store.json`. That entry belongs to pi's
 * `withRemoteCatalog()`, which persists `{models, checkedAt, lastModified,
 * etag}` and uses ETag/304 plus a `lastModified` vs bundled-`generatedAt`
 * freshness rule; our old write carried neither field, so pi ignored the models
 * we stored and re-downloaded the whole catalog every refresh.
 */
export function composeMetaModels(
	base: readonly MetaProviderModel[],
): MetaProviderModel[] {
	const live = liveCatalog.models ?? [];
	const source =
		live.length > 0 ? live : base.length > 0 ? base : FALLBACK_MODELS;
	const upstream = new Map(base.map((model) => [model.id, model]));
	const seen = new Set<string>();
	const composed: MetaProviderModel[] = [];
	for (const model of source) {
		if (seen.has(model.id)) continue;
		seen.add(model.id);
		composed.push(withMetaWireSettings(upstream.get(model.id) ?? model));
	}
	return composed;
}

/**
 * Fetch the Muse catalog with a key. Shared by the pi-driven refresh path and
 * the extension's own live discovery pass.
 */
function catalogHeaders(apiKey: string): Record<string, string> {
	return {
		Accept: "application/json",
		Authorization: `Bearer ${apiKey}`,
		"x-api-version": "1.0.0",
	};
}

type CatalogAttempt =
	| { kind: "http"; error: Error }
	| { kind: "local"; models: MetaProviderModel[]; error?: unknown };

/**
 * One catalog attempt. An HTTP status error is returned as `http` (auth and
 * quota do not depend on the address family, so it is never retried); a
 * transport failure is reported as an empty `local` result carrying the error,
 * because a missing IPv6 route or a DNS/TLS failure may well succeed over IPv4.
 */
async function attemptMetaCatalog(
	apiKey: string,
	fetchImpl: Fetch,
	signal?: AbortSignal,
): Promise<CatalogAttempt> {
	try {
		const response = await fetchImpl(META_MODEL_CATALOG_URL, {
			headers: catalogHeaders(apiKey),
			signal,
		});
		const body = (await responseBody(response)) as CatalogResponse &
			Record<string, unknown>;
		if (!response.ok) {
			return {
				kind: "http",
				error: new Error(
					`Meta model catalog failed (HTTP ${response.status})${errorDetail(body) ? `: ${errorDetail(body)}` : ""}`,
				),
			};
		}
		return { kind: "local", models: toProviderModels(body) };
	} catch (error) {
		return { kind: "local", models: [], error };
	}
}

/**
 * `META_CATALOG_IPV4=0|false|no|off` disables the IPv4 catalog retry.
 */
export function metaCatalogIPv4Enabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const raw = env["META_CATALOG_IPV4"]?.trim().toLowerCase();
	return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

/**
 * The fetch this module saw at load time. Production callers reach
 * `fetchMetaCatalog` with it; every hermetic test either replaces
 * `globalThis.fetch` afterwards or passes its own stub, so the identity check
 * keeps the IPv4 retry off the test path (it would otherwise hit the network).
 */
const moduleLoadFetch: Fetch = globalThis.fetch;

export type MetaCatalogIPv4Fetcher = (
	apiKey: string,
	signal?: AbortSignal,
) => Promise<MetaProviderModel[] | undefined>;

const catalogIPv4State: { fetcher?: MetaCatalogIPv4Fetcher } = {};

/** Test seam: replace (or clear) the IPv4 catalog transport. */
export function setMetaCatalogIPv4Fetcher(
	fetcher?: MetaCatalogIPv4Fetcher,
): void {
	catalogIPv4State.fetcher = fetcher;
}

/**
 * GET over a forced IPv4 socket. `node:https` is built into Node and Bun, so
 * this adds no dependency and no global dispatcher: undici's `fetch` cannot be
 * told which address family to use without one.
 */
async function nodeHttpsGetJson(
	url: string,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<{ status: number; body: unknown } | undefined> {
	try {
		const { request } = await import("node:https");
		const target = new URL(url);
		return await new Promise((resolve) => {
			const done = (
				value: { status: number; body: unknown } | undefined,
			): void => resolve(value);
			const req = request(
				{
					host: target.hostname,
					path: `${target.pathname}${target.search}`,
					method: "GET",
					family: 4,
					headers,
					...(signal ? { signal } : {}),
				},
				(res) => {
					res.setEncoding("utf8");
					let text = "";
					res.on("data", (chunk: string) => {
						text += chunk;
					});
					res.on("error", () => done(undefined));
					res.on("end", () => {
						try {
							done({ status: res.statusCode ?? 0, body: JSON.parse(text) });
						} catch {
							done(undefined);
						}
					});
				},
			);
			req.on("error", () => done(undefined));
			req.end();
		});
	} catch {
		return undefined;
	}
}

async function fetchMetaCatalogIPv4(
	apiKey: string,
	signal?: AbortSignal,
): Promise<MetaProviderModel[] | undefined> {
	const injected = catalogIPv4State.fetcher;
	if (injected) return injected(apiKey, signal);
	const result = await nodeHttpsGetJson(
		META_MODEL_CATALOG_URL,
		catalogHeaders(apiKey),
		signal,
	);
	if (!result || result.status !== 200) return undefined;
	const models = toProviderModels(result.body as CatalogResponse);
	return models.length > 0 ? models : undefined;
}

function shouldRetryCatalogOverIPv4(
	fetchImpl: Fetch,
	signal?: AbortSignal,
): boolean {
	if (signal?.aborted === true || !metaCatalogIPv4Enabled()) return false;
	// An injected transport is a test seam and never touches the network, so it
	// is always allowed; the real one only runs for the fetch this module saw at
	// load time, which is what production callers pass.
	return catalogIPv4State.fetcher !== undefined || fetchImpl === moduleLoadFetch;
}

/**
 * Fetch the catalog, retrying once over IPv4 when the first answer carries no
 * usable models.
 *
 * Measured 2026-10-11 against `api.meta.ai` from a dual-stack host: the IPv6
 * edge (`2a03:2880:f013::face:b00c:0:2`) answers `GET /v1/models` with HTTP
 * 200 and `{"object":"list","data":[]}` — 8/8 runs — while the IPv4 edge
 * (`157.240.205.1`) returns the full 8-model catalog, 8/8. `/v1/chat/completions`
 * splits the same way (404 over IPv6, 200 over IPv4). Pi runs on Node, whose
 * `fetch` prefers IPv6, so without this retry live discovery silently finds
 * nothing on such hosts and keys exposing only internal ids stay broken.
 * A 401/403 is never retried: auth does not depend on the address family.
 */
export async function fetchMetaCatalog(
	apiKey: string,
	fetchImpl: Fetch = fetch,
	signal?: AbortSignal,
): Promise<MetaProviderModel[]> {
	const primary = await attemptMetaCatalog(apiKey, fetchImpl, signal);
	if (primary.kind === "http") throw primary.error;
	if (primary.models.length > 0) return primary.models;
	if (!shouldRetryCatalogOverIPv4(fetchImpl, signal)) {
		if (primary.error) throw primary.error;
		return primary.models;
	}
	const ipv4 = await fetchMetaCatalogIPv4(apiKey, signal);
	if (ipv4 && ipv4.length > 0) return ipv4;
	if (primary.error) throw primary.error;
	return primary.models;
}

/**
 * The catalog this process fetched from Meta itself.
 *
 * Pi runs every in-session refresh with `allowNetwork: false`, and
 * `composeModelProvider()` then replaces the registered model list with
 * whatever that offline pass returns. Without this state the offline phase has
 * nothing account-specific to offer: `muse-spark-1.3` disappears from the model
 * list for a key that only exposes internal ids, pi warns "Model not found ...
 * Using custom model id", and Meta answers HTTP 404 `model_not_found` for a
 * model the key really can reach. Keeping the live catalog here lets every
 * later offline phase recompose from it.
 */
const liveCatalog: {
	models?: MetaProviderModel[];
	fetchedAt?: number;
} = {};

export async function refreshMetaModels(
	context: RefreshModelsContext,
	fetchImpl: Fetch = fetch,
): Promise<MetaProviderModel[]> {
	// SAFETY: CompatibleRefreshContext is the union of the Pi 0.83 and 0.84
	// refresh-context fields that this adapter probes defensively at runtime.
	const compatibleContext = context as unknown as CompatibleRefreshContext;
	// Pi's own rows for this provider: its static pins merged with whatever the
	// `pi.dev` remote catalog persisted. Read-only — see composeMetaModels().
	const base = await cachedMetaModels(compatibleContext);
	if (!context.allowNetwork || context.signal?.aborted) {
		return composeMetaModels(base);
	}
	const apiKey =
		context.credential?.type === "oauth"
			? context.credential.access
			: context.credential?.type === "api_key"
				? context.credential.key
				: undefined;
	if (!apiKey) return composeMetaModels(base);

	try {
		const models = await fetchMetaCatalog(apiKey, fetchImpl, context.signal);
		// An empty answer means "no information" (Meta's IPv6 edge answers 200
		// with an empty list), never "this key has no models": keep whatever the
		// previous pass knew.
		if (models.length > 0 && !context.signal?.aborted) {
			liveCatalog.models = models;
			liveCatalog.fetchedAt = Date.now();
		}
	} catch (error) {
		if (context.signal?.aborted) throw error;
		// A failed fetch leaves the previous live catalog, pi's rows and the
		// bundled pins in place.
	}
	return composeMetaModels(base);
}

export function metaFallbackCost(
	modelId: string,
): MetaProviderModel["cost"] | undefined {
	return FALLBACK_MODELS.find((model) => model.id === modelId)?.cost;
}

/** Meta prompt-cache opt-in. Measured 0% hits on /chat/completions vs 93–99% on /responses with 24h. */
export const META_PROMPT_CACHE_RETENTION = "24h";

const ENCRYPTED_REASONING_INCLUDE = "reasoning.encrypted_content";
const PROBE_RETRY_MS = 5 * 60 * 1000;

/**
 * Keys minted through /muse-code/key are not always entitled to encrypted
 * reasoning replay (Meta answers HTTP 400 "reasoning `encrypted_content`
 * was not issued to this caller" when they aren't). Entitlement can change
 * between minted keys, so probe once per key and model per process instead of
 * hard-coding a decision: requests never 400 and reasoning continuity is kept
 * whenever the key allows it.
 *
 * The probe must name a model the key can actually reach. Keys are scoped to
 * different id sets — a subscription key may expose only internal ids such as
 * `rl-muse-spark-1-3-sglang-playground` while `muse-spark-1.3` answers HTTP 404
 * `model_not_found` — so probing a fixed id would read "not entitled" for a key
 * that is entitled on the model in use.
 */
interface EntitlementState {
	known?: boolean;
	lastAttemptAt: number;
}
const entitlementCache = new Map<string, EntitlementState>();

function apiKeyHash(key: string): string {
	// Non-cryptographic FNV-1a; only used to key the in-process probe cache.
	let hash = 2166136261;
	for (let i = 0; i < key.length; i++) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}

function entitlementKey(apiKey: string, modelId: string): string {
	return `${apiKeyHash(apiKey)}:${modelId}`;
}

/**
 * Probe whether the given API key can request reasoning.encrypted_content on
 * `modelId`. Returns true (200), false (Meta rejects the include), or undefined
 * when the probe was inconclusive (unknown model, transient error) and must be
 * retried later.
 */
export async function probeEncryptedReasoningEntitlement(
	apiKey: string,
	modelId: string,
	fetchImpl: Fetch = fetch,
): Promise<boolean | undefined> {
	try {
		const response = await fetchImpl(`${META_API_BASE_URL}/responses`, {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"x-api-version": "1.0.0",
			},
			body: JSON.stringify({
				model: modelId,
				input: "Answer with the single letter: a",
				include: [ENCRYPTED_REASONING_INCLUDE],
				max_output_tokens: 16,
				store: false,
			}),
		});
		if (response.status === 200) return true;
		if (response.status === 400) {
			const text = await response.text();
			if (text.includes("encrypted_content")) return false;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function scheduleEntitlementProbe(apiKey: string, modelId: string): void {
	const key = entitlementKey(apiKey, modelId);
	const cached = entitlementCache.get(key);
	if (cached?.known !== undefined) return;
	const now = Date.now();
	if (cached && now - cached.lastAttemptAt < PROBE_RETRY_MS) return;
	entitlementCache.set(key, { known: cached?.known, lastAttemptAt: now });
	void probeEncryptedReasoningEntitlement(apiKey, modelId).then((known) => {
		if (known === undefined) return;
		entitlementCache.set(key, { known, lastAttemptAt: Date.now() });
	});
}

function keepEncryptedReasoningFor(
	apiKey: string | undefined,
	modelId: string | undefined,
): boolean {
	if (!apiKey || !modelId) return false;
	return entitlementCache.get(entitlementKey(apiKey, modelId))?.known === true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Hermes-equivalent Responses hints for api.meta.ai:
 * setdefault `prompt_cache_retention: 24h`, and drop `reasoning.effort: none`
 * because Meta 400s on it.
 */
export function applyMetaResponsesCacheHints(
	payload: unknown,
	keepEncryptedReasoning = false,
): Record<string, unknown> | undefined {
	const body = asRecord(payload);
	if (!body) return undefined;
	if (body.prompt_cache_retention === undefined) {
		body.prompt_cache_retention = META_PROMPT_CACHE_RETENTION;
	}
	// Drop the encrypted-reasoning include unless the key was probed and
	// found entitled: unentitled keys get a fatal HTTP 400 for it (see
	// probeEncryptedReasoningEntitlement). Other include entries survive.
	if (!keepEncryptedReasoning && Array.isArray(body.include)) {
		const include = body.include.filter(
			(item) => item !== "reasoning.encrypted_content",
		);
		if (include.length === 0) delete body.include;
		else body.include = include;
	}
	const reasoning = asRecord(body.reasoning);
	if (
		reasoning &&
		(reasoning.effort === "none" ||
			reasoning.effort === undefined ||
			reasoning.effort === null)
	) {
		delete body.reasoning;
	}
	return body;
}

/* ------------------------------------------------------------------ */
/* Transparent retry of transient Meta failures                        */
/* ------------------------------------------------------------------ */

/**
 * Meta's gateway answers a flooded or slow request with HTTP 5xx — most often
 * 504 `gateway_timeout` ("The response stream did not start before the server
 * timeout") — which pi-ai folds into a terminal `stopReason: "error"` turn.
 * Pi's provider retry runs with `retry.provider.maxRetries` (often 0) and the
 * agent-level retry is visible to the model through retry extensions, so a
 * short gateway hiccup used to surface as a failed turn and a visible
 * "Retry the previous request." message.
 *
 * This layer sits *below* pi, at the provider seam: `streamSimple` re-issues
 * the same context and options until a usable stream starts, and pi only ever
 * sees the final outcome. It mirrors pi-nvidia-plus's transparent transport
 * retry, with the provider seam as the transport (no undici dispatcher, no
 * extra runtime dependency).
 *
 * Safety rules, in order:
 * - once the attempt committed content to pi, it can never be replayed, so a
 *   failure after that point is surfaced verbatim (same bytes as today);
 * - aborted turns are terminal and never retried;
 * - context overflow is recovered by compaction, not by re-sending;
 * - non-transient text (`encrypted_content`, auth, quota, billing, content
 *   filters, bad requests) fails fast — checked BEFORE the retryable catalog so
 *   a `429 insufficient_quota` is not re-sent. The one exception is a 404
 *   `model_not_found` for an id Meta itself lists (see
 *   `isKnownMetaModelId`): the gateway flakes those, so they are retried;
 * - otherwise pi-ai's own `isRetryableAssistantError` catalog plus Meta/gateway
 *   wordings decides.
 *
 * Bounded exponential backoff (`minDelayMs * 2^(attempt-1)`, capped), abortable
 * during the wait. On exhaustion pi receives the *original* error, so behavior
 * without the layer is preserved. `META_TRANSPORT_RETRY=0` disables it.
 */
export interface MetaRetryConfig {
	/** Retries after the first attempt. */
	maxRetries: number;
	/** First backoff delay; doubled per attempt. */
	minDelayMs: number;
	/** Backoff ceiling. */
	maxDelayMs: number;
}

export const DEFAULT_META_RETRY: MetaRetryConfig = {
	maxRetries: 3,
	minDelayMs: 2_000,
	maxDelayMs: 30_000,
};

/**
 * The flaky-404 class gets a deeper, tighter budget than a 504: Meta answers it
 * in ~150ms without reaching the model, so attempts are nearly free, and a
 * degraded window needs depth rather than distance. Measured 2026-10-11: the
 * same key and model alternated between healthy windows (12/12 and 40/40
 * requests fine) and hard ones (16/16, then 10/10, then 9/10 identical requests
 * answering 404 `model_not_found`), with roughly 1 request in 6 succeeding
 * inside a window. Four attempts at 2s→4s→8s turn that into a 14s hang and a
 * ~50% failure rate; eight attempts inside ~6s reach ~77%.
 *
 * Applied only when the caller injected no config, so test seams and
 * `META_TRANSPORT_RETRY` tuning are honored verbatim.
 */
export const FLAKY_NOT_FOUND_META_RETRY: MetaRetryConfig = {
	maxRetries: 7,
	minDelayMs: 250,
	maxDelayMs: 1_000,
};

function effectiveRetryConfig(
	errorText: string,
	knownModel: boolean,
	config: MetaRetryConfig,
	injected: boolean,
): MetaRetryConfig {
	if (injected || !knownModel) return config;
	return META_MODEL_NOT_FOUND_RE.test(errorText)
		? FLAKY_NOT_FOUND_META_RETRY
		: config;
}

/** `META_TRANSPORT_RETRY=0|false|no|off` disables the transparent retry layer. */
export function metaTransportRetryEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const raw = env["META_TRANSPORT_RETRY"]?.trim().toLowerCase();
	return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

/** Flat-then-exponential backoff with a hard ceiling. */
export function metaRetryDelayMs(
	attempt: number,
	config: MetaRetryConfig,
): number {
	const delay = config.minDelayMs * 2 ** Math.max(0, attempt - 1);
	const safe = Number.isSafeInteger(delay) ? delay : config.maxDelayMs;
	return Math.min(safe, config.maxDelayMs);
}

/**
 * Non-transient failures win over every retryable pattern: a 429 that means
 * "billing exhausted" or a deterministic 400/404 must not be re-sent.
 */
const META_NON_RETRYABLE_RE =
	/encrypted_content|model_?not_?found|invalid_api_key|unauthoriz|forbidden|permission|denied|authenticat|billing|insufficient|quota exceeded|out of budget|content.?filter|moderation|context.?(length|window)|exceeds.{0,24}(context|maximum)|too long|bad request|malformed|unsupported|not.?(found|supported)|deprecated/i;

/** Meta/gateway wordings pi-ai's transient catalog does not cover yet. */
const META_RETRYABLE_RE =
	/gateway_?timeout|did not start before the server timeout|response stream did not start|resource_?exhausted|overload|temporaril|too many requests|try again|try your request|service.?unavailable|high demand/i;

/** Meta's "this model does not exist" 404 body. */
const META_MODEL_NOT_FOUND_RE = /model_?not_?found|"code"\s*:\s*"model/i;

/**
 * A 404 that survived every retry is not a gateway flake. Remember it per
 * (key, model) so later turns fail fast after one attempt instead of paying the
 * whole backoff again. The mark is cleared by the next turn that delivers
 * content (`clearMetaModelNotFound`), so recovery is immediate; the TTL is only
 * a safety net for a session that never asks again.
 *
 * Measured 2026-10-11: the flake rate swings from 0/12 to a hard window of
 * 16/16 identical requests, so both the retry and the fail-fast matter.
 */
const NOT_FOUND_BACKOFF_MS = 5 * 60 * 1000;
const notFoundCache = new Map<string, number>();

function notFoundKey(apiKey: string | undefined, modelId: string): string {
	return `${apiKey ? apiKeyHash(apiKey) : "nokey"}:${modelId}`;
}

function notFoundRecently(
	apiKey: string | undefined,
	modelId: string,
	now: number = Date.now(),
): boolean {
	const at = notFoundCache.get(notFoundKey(apiKey, modelId));
	return at !== undefined && now - at < NOT_FOUND_BACKOFF_MS;
}

export function markMetaModelNotFound(
	apiKey: string | undefined,
	modelId: string,
): void {
	notFoundCache.set(notFoundKey(apiKey, modelId), Date.now());
}

/** A turn that delivered content proves the id reachable again. */
export function clearMetaModelNotFound(
	apiKey: string | undefined,
	modelId: string,
): void {
	notFoundCache.delete(notFoundKey(apiKey, modelId));
}

/**
 * Is this id one Meta (or our own measured pins) says exists?
 *
 * The live catalog wins when this process fetched one; otherwise the bundled
 * pins stand in. Used to tell a gateway flake from a typo'd or retired id. An
 * id that already burned a full retry cycle on `model_not_found` counts as
 * unknown for `NOT_FOUND_BACKOFF_MS`, so a key that simply is not entitled to a
 * pinned id fails fast on the next turn instead of paying the backoff again.
 */
export function isKnownMetaModelId(
	modelId: string | undefined,
	apiKey?: string,
): boolean {
	if (!modelId) return false;
	if (notFoundRecently(apiKey, modelId)) return false;
	const live = liveCatalog.models;
	if (live && live.length > 0) return live.some((model) => model.id === modelId);
	return FALLBACK_MODELS.some((model) => model.id === modelId);
}

/**
 * Classifies a terminal assistant message as a transparently retryable failure.
 *
 * `knownModel` says whether the failing id is one Meta lists (defaults to a
 * lookup of `message.model`). A 404 `model_not_found` on a known-good id is a
 * gateway flake and is retried; measured 2026-10-11 against
 * `api.meta.ai/v1/responses` with a valid Muse key and `muse-spark-1.3`: 5 of
 * 12 identical raw requests and 2 of 12 plugin-level turns answered HTTP 404
 * `{"code":"model_not_found"}` on both IPv4 and IPv6, and the next attempt
 * succeeded. Without this exception roughly one turn in six died with a
 * misleading "model not found". An id Meta does not list stays non-retryable,
 * so a typo or a retired model still fails fast.
 */
export function isRetryableMetaError(
	message: AssistantMessage,
	contextWindow?: number,
	knownModel?: boolean,
): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	// Overflow is recovered by compaction, never by re-sending the same context.
	if (isContextOverflow(message, contextWindow)) return false;
	if (META_NON_RETRYABLE_RE.test(message.errorMessage)) {
		return (
			(knownModel ?? isKnownMetaModelId(message.model)) &&
			META_MODEL_NOT_FOUND_RE.test(message.errorMessage)
		);
	}
	if (isRetryableAssistantError(message)) return true;
	return META_RETRYABLE_RE.test(message.errorMessage);
}

type MetaStreamSimple = NonNullable<ProviderConfig["streamSimple"]>;
type MetaStreamModel = Parameters<MetaStreamSimple>[0];
type MetaStreamContext = Parameters<MetaStreamSimple>[1];
type MetaStreamOptions = Parameters<MetaStreamSimple>[2];

/** The Responses implementation, structurally typed to survive pi 0.83→0.86 drift. */
export interface MetaInnerApi {
	streamSimple(
		model: MetaStreamModel,
		context: MetaStreamContext,
		options?: MetaStreamOptions,
	): AssistantMessageEventStream;
}

let cachedInnerApi: MetaInnerApi | undefined;
function metaInnerApi(): MetaInnerApi {
	// `openAIResponsesApi()` is a lazy wrapper; cache it, but keep it injectable.
	return (cachedInnerApi ??= openAIResponsesApi() as unknown as MetaInnerApi);
}

type MetaNotifier = (message: string, type: "info" | "warning" | "error") => void;

/**
 * Session-scoped side channels for the retry layer: user notifications and the
 * live-catalog repair hook, both bound in `session_start`. Absent in headless
 * runs and tests, where they are simply not called.
 */
const metaStreamState: {
	notify?: MetaNotifier;
	refreshCatalog?: () => void;
} = {};

/** Binds (or clears) the session side channels; called from `session_start`. */
export function bindMetaStreamState(hooks: {
	notify?: MetaNotifier;
	refreshCatalog?: () => void;
}): void {
	metaStreamState.notify = hooks.notify;
	metaStreamState.refreshCatalog = hooks.refreshCatalog;
}

/** Test seam: drop session bindings and the exhaustion-notification dedupe. */
export function resetMetaStreamState(): void {
	bindMetaStreamState({});
	retryExhaustedNotified.clear();
}

/** Learned per (key, model): has this key been rejected for `reasoning.encrypted_content`? */
export function encryptedReasoningEntitlement(
	apiKey: string,
	modelId: string,
): boolean | undefined {
	return entitlementCache.get(entitlementKey(apiKey, modelId))?.known;
}

/**
 * Learn from a terminal Meta failure so the *next* request is not set up to
 * fail the same way:
 * - `reasoning.encrypted_content was not issued to this caller` → remember the
 *   key/model as not entitled, so the include is stripped from now on;
 * - `model_not_found` → the registered catalog drifted from the key's real
 *   ids; kick a background live-catalog repair (cooldown-guarded).
 */
export function learnFromMetaError(
	text: string,
	modelId: string,
	apiKey?: string,
): void {
	if (!text) return;
	if (apiKey && text.includes("encrypted_content")) {
		entitlementCache.set(entitlementKey(apiKey, modelId), {
			known: false,
			lastAttemptAt: Date.now(),
		});
	}
	if (/model_?not_?found|"code"\s*:\s*"model/i.test(text)) {
		metaStreamState.refreshCatalog?.();
	}
}

interface MetaAttemptFailure {
	kind: "error";
	message: AssistantMessage;
	/** Uncommitted events (the `start` event, usually) to flush when giving up. */
	pending: AssistantMessageEvent[];
	/** True once content reached pi: the attempt can no longer be replayed. */
	committed: boolean;
}

type MetaAttempt = { kind: "committed" } | MetaAttemptFailure;

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function metaErrorMessage(model: MetaStreamModel, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/**
 * One attempt. Events are buffered until the first content-bearing event: that
 * is what distinguishes "the gateway never started the stream, retry is safe"
 * from "tokens already reached pi". A happy stream therefore keeps its full
 * flow — only the first content event is delayed by one event — and pi never
 * sees a discarded attempt.
 */
async function runMetaAttempt(
	outer: AssistantMessageEventStream,
	inner: MetaInnerApi,
	model: MetaStreamModel,
	context: MetaStreamContext,
	options: MetaStreamOptions,
): Promise<MetaAttempt> {
	const pending: AssistantMessageEvent[] = [];
	let committed = false;
	const emit = (event: AssistantMessageEvent): void => {
		if (committed) outer.push(event);
		else pending.push(event);
	};
	const commit = (): void => {
		if (committed) return;
		committed = true;
		while (pending.length > 0) {
			outer.push(pending.shift() as AssistantMessageEvent);
		}
	};

	let terminal = false;
	for await (const event of inner.streamSimple(model, context, options)) {
		if (event.type === "done") {
			terminal = true;
			emit(event);
			commit();
			continue;
		}
		if (event.type === "error") {
			return { kind: "error", message: event.error, pending, committed };
		}
		if (event.type === "start") {
			// `start` carries no content; hold it so a discarded attempt leaves no
			// stray partial assistant message in pi's transcript.
			emit(event);
			continue;
		}
		// First content-bearing event: the response now belongs to pi.
		emit(event);
		commit();
	}
	if (!terminal) {
		return {
			kind: "error",
			message: metaErrorMessage(
				model,
				new Error("Meta stream ended without a terminal event"),
			),
			pending,
			committed,
		};
	}
	commit();
	return { kind: "committed" };
}

/** Abortable backoff; resolves true when the wait was cut short by the signal. */
function interruptibleRetrySleep(
	delayMs: number,
	signal?: AbortSignal,
): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve(true);
			return;
		}
		const onAbort = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(false);
		}, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

const retryExhaustedNotified = new Map<string, number>();

function briefMetaError(message: string | undefined, maxChars = 160): string {
	const text = (message ?? "unknown error").replace(/\s+/g, " ").trim();
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function notifyRetryExhausted(info: {
	attempts: number;
	errorMessage: string;
}): void {
	const key = briefMetaError(info.errorMessage);
	const now = Date.now();
	const last = retryExhaustedNotified.get(key);
	if (last !== undefined && now - last < 60_000) return;
	// The map only exists to dedupe; never let it grow without bound.
	if (retryExhaustedNotified.size >= 64) {
		for (const [entry, at] of retryExhaustedNotified) {
			if (now - at >= 600_000) retryExhaustedNotified.delete(entry);
		}
		if (retryExhaustedNotified.size >= 64) retryExhaustedNotified.clear();
	}
	retryExhaustedNotified.set(key, now);
	metaStreamState.notify?.(
		`pi-meta: giving up after ${info.attempts} attempts — ${briefMetaError(info.errorMessage, 240)}`,
		"warning",
	);
}

export interface MetaStreamRetryDeps {
	/** Inner Responses implementation; injectable for tests. */
	inner?: MetaInnerApi;
	/** Backoff sleep; resolves true when the signal aborted the wait. */
	sleep?: (delayMs: number, signal?: AbortSignal) => Promise<boolean>;
	config?: MetaRetryConfig;
	enabled?: boolean;
	env?: Record<string, string | undefined>;
	/** A retry was scheduled (1-based retry number). */
	onRetryScheduled?: (info: {
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		errorMessage: string;
	}) => void;
	/** The retry budget is spent and pi is about to receive the error. */
	onRetryExhausted?: (info: { attempts: number; errorMessage: string }) => void;
}

/**
 * The transparent-retry `streamSimple` handler. Never rejects and never throws
 * synchronously: every outcome ends the returned stream with a terminal event,
 * so pi's stream contract is preserved even if the inner API misbehaves.
 */
export function streamMetaSimple(
	model: MetaStreamModel,
	context: MetaStreamContext,
	options?: MetaStreamOptions,
	deps: MetaStreamRetryDeps = {},
): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();
	const inner = deps.inner ?? metaInnerApi();
	const config = deps.config ?? DEFAULT_META_RETRY;
	const enabled = deps.enabled ?? metaTransportRetryEnabled(deps.env);
	const sleep = deps.sleep ?? interruptibleRetrySleep;

	const deliverFailure = (
		failure: MetaAttemptFailure,
		reason: "error" | "aborted",
		message: AssistantMessage = failure.message,
	): void => {
		for (const event of failure.pending) outer.push(event);
		outer.push({ type: "error", reason, error: message });
		outer.end();
	};

	void (async () => {
		for (let attempt = 1; ; attempt++) {
			let result: MetaAttempt;
			try {
				result = await runMetaAttempt(outer, inner, model, context, options);
			} catch (error) {
				// The inner API must fold its own throws into error events; keep the
				// stream contract anyway instead of leaving pi waiting forever.
				const aborted = options?.signal?.aborted === true;
				const message = metaErrorMessage(model, error);
				if (aborted) {
					delete message.errorMessage;
					message.stopReason = "aborted";
				} else {
					learnFromMetaError(message.errorMessage ?? "", model.id, options?.apiKey);
				}
				outer.push({
					type: "error",
					reason: aborted ? "aborted" : "error",
					error: message,
				});
				outer.end();
				return;
			}
			if (result.kind === "committed") {
				// Content reached pi: whatever a previous turn concluded about this
				// id, it is reachable now.
				clearMetaModelNotFound(options?.apiKey, model.id);
				outer.end();
				return;
			}

			const failure = result.message;
			const errorText = failure.errorMessage ?? "";
			learnFromMetaError(errorText, model.id, options?.apiKey);

			const knownModel = isKnownMetaModelId(model.id, options?.apiKey);
			const budget = effectiveRetryConfig(
				errorText,
				knownModel,
				config,
				deps.config !== undefined,
			);
			const retryable =
				enabled &&
				!options?.signal?.aborted &&
				!result.committed &&
				attempt <= budget.maxRetries &&
				isRetryableMetaError(failure, model.contextWindow, knownModel);
			if (!retryable) {
				// Retried and still 404: stop paying the backoff for this id until a
				// turn succeeds again. `attempt > 1` keeps an id nothing ever vouched
				// for (a typo) out of the cache — it was never retried in the first
				// place.
				if (attempt > 1 && META_MODEL_NOT_FOUND_RE.test(errorText)) {
					markMetaModelNotFound(options?.apiKey, model.id);
				}
				deliverFailure(
					result,
					failure.stopReason === "aborted" ? "aborted" : "error",
				);
				if (attempt > 1) {
					deps.onRetryExhausted?.({ attempts: attempt, errorMessage: errorText });
				}
				return;
			}

			const delayMs = metaRetryDelayMs(attempt, budget);
			deps.onRetryScheduled?.({
				attempt,
				maxAttempts: budget.maxRetries,
				delayMs,
				errorMessage: errorText,
			});
			if (await sleep(delayMs, options?.signal)) {
				// Mirrors pi's own retry loop: an abort during the backoff is reported
				// as an aborted turn, not as the transient failure that triggered it.
				const { errorMessage: _dropped, ...rest } = failure;
				deliverFailure(result, "aborted", { ...rest, stopReason: "aborted" });
				return;
			}
		}
	})();

	return outer;
}

/**
 * Provider-config handler binding the retry layer to session notifications.
 * `deps` exists only as a test seam: production callers pass nothing.
 */
export function createMetaStreamSimple(
	deps: MetaStreamRetryDeps = {},
): MetaStreamSimple {
	return (model, context, options) =>
		streamMetaSimple(model, context, options, {
			...deps,
			onRetryScheduled: (info) => {
				deps.onRetryScheduled?.(info);
				if (!metaStreamState.notify) return;
				const seconds = Math.max(1, Math.round(info.delayMs / 1000));
				metaStreamState.notify(
					`pi-meta: transient Meta failure, retrying in ${seconds}s (retry ${info.attempt}/${info.maxAttempts}): ${briefMetaError(info.errorMessage)}`,
					"info",
				);
			},
			onRetryExhausted: (info) => {
				deps.onRetryExhausted?.(info);
				notifyRetryExhausted(info);
			},
		});
}

export function createMetaProviderConfig(): MetaProviderConfig {
	return {
		name: "Meta Model API",
		baseUrl: META_API_BASE_URL,
		api: "openai-responses",
		apiKey: "$META_API_KEY",
		models: [...FALLBACK_MODELS],
		streamSimple: createMetaStreamSimple(),
		refreshModels: refreshMetaModels,
		oauth: {
			name: "Meta Model API (browser login or API key)",
			// Muse access is subscription-backed, matching pi's built-in Meta
			// provider, so the status bar reports usage as "(sub)".
			isSubscription: true,
			login: loginMeta,
			refreshToken: refreshMetaToken,
			getApiKey: (credentials: { access: string }) => credentials.access,
		},
	};
}

/**
 * Live catalog discovery for a running session.
 *
 * Pi 0.86 builds its session ModelRuntime without `allowModelNetwork`, and
 * every in-session refresh runs with `allowNetwork: false`; the only networked
 * caller, `pi update --models`, does not load extensions at all. Asking pi for
 * a networked refresh from `session_start` does not help either: pi's startup
 * fires dozens of offline refreshes, and `Models.beginProviderRefresh()`
 * supersedes (aborts) an in-flight refresh of the same provider, so an
 * extension-triggered live pass is silently cancelled before it reaches the
 * network.
 *
 * So the extension fetches the catalog itself with the resolved key, stores it
 * in `liveCatalog` (which every later `refreshMetaModels` pass recomposes from,
 * offline phases included), and re-registers the provider so the picker and the
 * model snapshot update without waiting for a refresh nobody triggers.
 * Fire-and-forget and cooldown-guarded: startup never blocks on Meta, and a
 * failed fetch leaves pi's own rows and the bundled pins in place.
 */
const catalogRefreshState: {
	lastAttemptAt?: number;
	inFlight?: Promise<void>;
} = {};

export function shouldRefreshCatalog(now: number): boolean {
	if (process.env["PI_OFFLINE"] !== undefined) return false;
	if (catalogRefreshState.inFlight) return false;
	// An undefined timestamp means "never attempted", not "attempted at epoch 0".
	if (catalogRefreshState.lastAttemptAt === undefined) return true;
	return (
		now - catalogRefreshState.lastAttemptAt >= CATALOG_REFRESH_COOLDOWN_MS
	);
}

export function startLiveCatalogRefresh(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	now: number = Date.now(),
): Promise<void> | undefined {
	if (!shouldRefreshCatalog(now)) return undefined;
	catalogRefreshState.lastAttemptAt = now;
	const signal = AbortSignal.timeout(CATALOG_REFRESH_TIMEOUT_MS);
	let tracked: Promise<void>;
	const run = (async () => {
		try {
			const apiKey = (await ctx.modelRegistry?.getProviderAuth(
				META_PROVIDER_ID,
			))?.auth?.apiKey;
			if (!apiKey || signal.aborted) return;
			const models = await fetchMetaCatalog(apiKey, fetch, signal);
			if (models.length === 0 || signal.aborted) return;
			liveCatalog.models = models;
			liveCatalog.fetchedAt = Date.now();
			// Re-registration takes effect immediately after binding, and the
			// offline refresh it kicks recomposes from the same live catalog plus
			// pi's own rows. `registerProvider()` merges by key, so `models` must be
			// present: an omitted key would keep the previous value.
			pi.registerProvider(META_PROVIDER_ID, {
				...createMetaProviderConfig(),
				models: composeMetaModels([]),
			});
		} catch {
			// A failed catalog fetch is not fatal: pi's own rows and the bundled
			// pins stay registered.
		}
	})();
	// Compare against the tracked promise itself: `run.finally(...)` returns a new
	// promise, so testing `run` would leave the in-flight guard set forever.
	tracked = run.finally(() => {
		if (catalogRefreshState.inFlight === tracked) {
			delete catalogRefreshState.inFlight;
		}
	});
	catalogRefreshState.inFlight = tracked;
	return tracked;
}

/** Test seam: drop the cooldown and live catalog so each pass starts clean. */
export function resetCatalogRefreshState(): void {
	delete catalogRefreshState.lastAttemptAt;
	delete catalogRefreshState.inFlight;
	delete liveCatalog.models;
	delete liveCatalog.fetchedAt;
	// The fail-fast marks are process state too; tests must not inherit them.
	notFoundCache.clear();
}

export default function metaOAuthProvider(pi: ExtensionAPI): void {
	// Allow MODEL_API_KEY as fallback for API-key users — shim to META_API_KEY so $META_API_KEY interpolation works.
	if (
		process.env[META_ENV_VAR] === undefined &&
		process.env["MODEL_API_KEY"] !== undefined
	) {
		process.env[META_ENV_VAR] = process.env["MODEL_API_KEY"];
	}
	if (
		process.env["MODEL_API_KEY"] === undefined &&
		process.env[META_ENV_VAR] !== undefined
	) {
		process.env["MODEL_API_KEY"] = process.env[META_ENV_VAR];
	}
	pi.registerProvider(META_PROVIDER_ID, createMetaProviderConfig());
	pi.on("session_start", (_event, ctx) => {
		bindMetaStreamState({
			// Headless runs have no UI; notifications are simply skipped there.
			...(ctx.hasUI
				? { notify: (message: string, type: "info" | "warning" | "error") => ctx.ui.notify(message, type) }
				: {}),
			// A `model_not_found` turn lets the retry layer repair the registered ids.
			refreshCatalog: () => {
				void startLiveCatalogRefresh(pi, ctx);
			},
		});
		// Discover the ids this key can actually reach; see startLiveCatalogRefresh.
		void startLiveCatalogRefresh(pi, ctx);
	});
	pi.on("before_provider_request", async (event, ctx) => {
		if (ctx.model?.provider !== META_PROVIDER_ID) return undefined;
		let apiKey: string | undefined;
		try {
			apiKey = (await ctx.modelRegistry?.getProviderAuth(META_PROVIDER_ID))
				?.auth?.apiKey;
		} catch {
			apiKey = undefined;
		}
		const modelId = ctx.model?.id;
		if (apiKey && modelId) scheduleEntitlementProbe(apiKey, modelId);
		return applyMetaResponsesCacheHints(
			event.payload,
			keepEncryptedReasoningFor(apiKey, modelId),
		);
	});
}

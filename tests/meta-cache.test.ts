/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyMetaResponsesCacheHints,
	createMetaProviderConfig,
	META_API_BASE_URL,
	META_MODEL_CATALOG_URL,
	META_PROMPT_CACHE_RETENTION,
	META_PROVIDER_ID,
	probeEncryptedReasoningEntitlement,
	resetCatalogRefreshState,
	shouldRefreshCatalog,
	startLiveCatalogRefresh,
	toProviderModels,
} from "../extensions/meta.ts";
import metaOAuthProvider from "../extensions/meta.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const LIVE_CACHE_KEY = "pi-meta-oauth-live-cache-probe-v1";
/** Fallback probe target; the live catalog's first id wins when it resolves. */
const LIVE_CACHE_MODEL_FALLBACK = "muse-spark-1.2-contributor";

function resolveLiveMetaApiKey(): string | undefined {
	for (const value of [
		process.env.PI_META_LIVE_API_KEY,
		process.env.META_API_KEY,
		process.env.MODEL_API_KEY,
	]) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	try {
		const auth = JSON.parse(
			readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"),
		) as {
			meta?: { type?: string; key?: unknown; access?: unknown; expires?: unknown };
		};
		// auth.meta.expires is epoch milliseconds; an expired token must not turn
		// every test run into a hard 401 — treat it as no credential.
		if (
			typeof auth.meta?.expires === "number" &&
			auth.meta.expires <= Date.now()
		) {
			return undefined;
		}
		// Pi stores a pasted Model API key as { type: "api_key", key } and a
		// device-flow credential as { type: "oauth", access }.
		const candidate = auth.meta?.key ?? auth.meta?.access;
		return typeof candidate === "string" && candidate.trim()
			? candidate.trim()
			: undefined;
	} catch {
		return undefined;
	}
}

const liveApiKey = resolveLiveMetaApiKey();
const liveCacheTest = liveApiKey ? test : test.skip;

/**
 * Keys are scoped to different id sets: a subscription key may expose only
 * internal ids while the public `muse-spark-*` ids answer 404. Resolve the
 * probe model from the live catalog so the cache measurement runs against an
 * id the key can actually reach.
 */
async function resolveLiveCacheModel(apiKey: string): Promise<string> {
	try {
		const response = await fetch(META_MODEL_CATALOG_URL, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
				"x-api-version": "1.0.0",
			},
		});
		if (response.ok) {
			const body = (await response.json()) as {
				data?: Array<{ id?: unknown }>;
			};
			const first = body.data?.find(
				(entry) => typeof entry.id === "string" && entry.id,
			)?.id as string | undefined;
			if (first) return first;
		}
	} catch {
		// Fall through to the bundled probe id.
	}
	return LIVE_CACHE_MODEL_FALLBACK;
}

function fallbackModels() {
	const models = createMetaProviderConfig().models ?? [];
	if (models.length === 0) throw new Error("Meta fallback models are required");
	return models;
}

function museModel(
	id = "muse-spark-1.2-contributor",
): Model<"openai-responses"> {
	const fallback =
		fallbackModels().find((model) => model.id === id) ?? fallbackModels()[0];
	if (!fallback) throw new Error("Meta fallback model is required");
	return {
		...fallback,
		api: "openai-responses",
		provider: META_PROVIDER_ID,
		baseUrl: META_API_BASE_URL,
		input: fallback.input as Model<"openai-responses">["input"],
		compat: fallback.compat as Model<"openai-responses">["compat"],
	};
}

async function captureResponsesRequest(options?: {
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	cacheRetention?: "none" | "short" | "long";
	sessionId?: string;
	applyHints?: boolean;
}): Promise<{ url?: string; payload?: Record<string, unknown> }> {
	let url: string | undefined;
	let payload: Record<string, unknown> | undefined;
	const events = streamSimple(
		museModel(),
		// Pi 0.86 hands provider streams a branded TranscriptContext; normalizeContext
		// is the only public constructor for one.
		normalizeContext({
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		}),
		{
			apiKey: "test-key",
			sessionId: options?.sessionId ?? "sid",
			reasoning: options?.reasoning,
			cacheRetention: options?.cacheRetention,
			fetch: (async (input: RequestInfo | URL) => {
				url = String(input);
				return new Response("not a stream", { status: 400 });
			}) as typeof fetch,
			onPayload: (next) => {
				const hinted = options?.applyHints
					? applyMetaResponsesCacheHints(next)
					: next;
				payload =
					hinted && typeof hinted === "object"
						? (hinted as Record<string, unknown>)
						: undefined;
				return hinted;
			},
		},
	);
	for await (const _event of events) {
		// Drain until the mocked 400 terminates the stream.
	}
	return { url, payload };
}

describe("Meta Responses cache and reasoning contracts", () => {
	test("routes Muse through openai-responses on api.meta.ai", () => {
		const config = createMetaProviderConfig();
		expect(config.api).toBe("openai-responses");
		expect(config.baseUrl).toBe("https://api.meta.ai/v1");
		expect(config.baseUrl).toBe(META_API_BASE_URL);
		expect(new URL(META_API_BASE_URL).hostname).toBe("api.meta.ai");
	});

	test("does not disable long prompt-cache retention on fallback or catalog models", () => {
		for (const model of [
			...fallbackModels(),
			...toProviderModels({ data: [{ id: "muse-spark-1.2" }] }),
		]) {
			const compat = model.compat as
				| { supportsLongCacheRetention?: boolean }
				| undefined;
			expect(compat?.supportsLongCacheRetention).not.toBe(false);
		}
	});

	test("prices contributor cache reads at the measured 50x discount", () => {
		const contributor = fallbackModels().find(
			(model) => model.id === "muse-spark-1.2-contributor",
		);
		expect(contributor?.cost).toMatchObject({
			input: 0.1,
			cacheRead: 0.002,
		});
		expect(
			contributor && contributor.cost.input / contributor.cost.cacheRead,
		).toBe(50);
	});

	test("keeps off unmapped so Meta never receives reasoning.effort none by default", () => {
		for (const model of fallbackModels()) {
			expect(model.thinkingLevelMap?.off).toBeNull();
			// 1.3 standard is the only Spark that maps thinking `max` → `max`.
			expect(model.thinkingLevelMap?.max).toBe(
				model.id === "muse-spark-1.3" ? "max" : null,
			);
		}
		const catalogued = toProviderModels({
			data: [
				{
					id: "muse-spark-1.2",
					metadata: {
						"muse-code": {
							variants: { off: { reasoningEffort: "none" } },
						},
					},
				},
			],
		});
		expect(catalogued[0]?.thinkingLevelMap).toMatchObject({
			off: null,
			max: null,
		});
	});

	test("advertises the text and image inputs Muse Spark actually accepts", async () => {
		for (const model of fallbackModels()) {
			// Pi types Model.input as ("text" | "image")[] through 0.86; video and
			// audio cannot be attached, so advertising them would only mislead gating.
			expect(model.input).toEqual(["text", "image"]);
		}
		expect(
			toProviderModels({
				data: [
					{
						id: "muse-spark-test",
						metadata: {
							"muse-code": {
								modalities: {
									input: ["text", "image", "video", "audio", "pdf"],
								},
							},
						},
					},
				],
			})[0]?.input,
		).toEqual(["text", "image"]);
	});

	test("setdefault prompt_cache_retention 24h and preserve an explicit override", () => {
		expect(
			applyMetaResponsesCacheHints({ model: "muse-spark-1.2" }),
		).toMatchObject({
			model: "muse-spark-1.2",
			prompt_cache_retention: META_PROMPT_CACHE_RETENTION,
		});
		expect(
			applyMetaResponsesCacheHints({
				prompt_cache_retention: "in_memory",
			}),
		).toMatchObject({ prompt_cache_retention: "in_memory" });
	});

	test("strips reasoning.effort none because Meta rejects it", () => {
		expect(
			applyMetaResponsesCacheHints({
				reasoning: { effort: "none", summary: "auto" },
			}),
		).toEqual({ prompt_cache_retention: "24h" });
		expect(
			applyMetaResponsesCacheHints({
				reasoning: { effort: "high", summary: "auto" },
			}),
		).toMatchObject({
			reasoning: { effort: "high", summary: "auto" },
		});
	});

	test("strips reasoning.encrypted_content include when the key is not entitled", () => {
		expect(
			applyMetaResponsesCacheHints({
				include: ["reasoning.encrypted_content"],
				reasoning: { effort: "high", summary: "auto" },
			}),
		).toEqual({
			prompt_cache_retention: "24h",
			reasoning: { effort: "high", summary: "auto" },
		});
		expect(
			applyMetaResponsesCacheHints({
				include: ["reasoning.encrypted_content", "something.else"],
			}),
		).toMatchObject({ include: ["something.else"] });
	});

	test("keeps reasoning.encrypted_content include when the key is entitled", () => {
		expect(
			applyMetaResponsesCacheHints(
				{
					include: ["reasoning.encrypted_content"],
					reasoning: { effort: "high", summary: "auto" },
				},
				true,
			),
		).toEqual({
			prompt_cache_retention: "24h",
			include: ["reasoning.encrypted_content"],
			reasoning: { effort: "high", summary: "auto" },
		});
	});

	test("probes encrypted-reasoning entitlement: 200 means entitled", async () => {
		const known = await probeEncryptedReasoningEntitlement(
			"test-key",
			"muse-spark-1.2-contributor",
			(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
		);
		expect(known).toBe(true);
	});

	test("probe reports not entitled when Meta rejects encrypted_content", async () => {
		const known = await probeEncryptedReasoningEntitlement(
			"test-key",
			"muse-spark-1.2-contributor",
			(async () =>
				new Response(
					'{"type":"invalid_request_error","message":"reasoning `encrypted_content` was not issued to this caller"}',
					{ status: 400 },
				)) as unknown as typeof fetch,
		);
		expect(known).toBe(false);
	});

	test("probe is inconclusive on transient errors", async () => {
		const known = await probeEncryptedReasoningEntitlement(
			"test-key",
			"muse-spark-1.2-contributor",
			(async () => new Response("{}", { status: 502 })) as unknown as typeof fetch,
		);
		expect(known).toBeUndefined();
	});

	// Keys are scoped to different id sets: a subscription key may expose only
	// internal ids while `muse-spark-1.3` answers 404 model_not_found. Probing a
	// fixed id would then misread "unknown model" as "not entitled".
	test("probe names the model in use, never a fixed id", async () => {
		const bodies: unknown[] = [];
		await probeEncryptedReasoningEntitlement(
			"test-key",
			"rl-muse-spark-1-3-sglang-playground",
			(async (_input: unknown, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body)));
				return new Response("{}", { status: 404 });
			}) as unknown as typeof fetch,
		);
		expect(bodies[0]).toMatchObject({
			model: "rl-muse-spark-1-3-sglang-playground",
			include: ["reasoning.encrypted_content"],
		});
	});

	test("probe is inconclusive when Meta does not know the model", async () => {
		const known = await probeEncryptedReasoningEntitlement(
			"test-key",
			"muse-spark-1.3",
			(async () =>
				new Response(
					'{"error":{"code":"model_not_found","message":"The requested model was not found."}}',
					{ status: 404 },
				)) as unknown as typeof fetch,
		);
		expect(known).toBeUndefined();
	});

	test("pi-ai hits /v1/responses, not /chat/completions", async () => {
		const { url, payload } = await captureResponsesRequest();
		expect(url).toContain("https://api.meta.ai/v1/responses");
		expect(url).not.toContain("/chat/completions");
		expect(payload).toMatchObject({
			model: "muse-spark-1.2-contributor",
			store: false,
		});
		expect(payload).toHaveProperty("input");
	});

	test("default Muse request omits reasoning and gains 24h retention after hints", async () => {
		const raw = await captureResponsesRequest();
		expect(raw.payload).not.toHaveProperty("reasoning");
		expect(raw.payload?.prompt_cache_retention).toBeUndefined();

		const hinted = await captureResponsesRequest({ applyHints: true });
		expect(hinted.payload).not.toHaveProperty("reasoning");
		expect(hinted.payload?.prompt_cache_retention).toBe("24h");
	});

	test("high reasoning effort passes through with an auto summary", async () => {
		const { payload } = await captureResponsesRequest({
			reasoning: "high",
			applyHints: true,
		});
		expect(payload?.reasoning).toEqual({ effort: "high", summary: "auto" });
	});

	test("prompt_cache_key is session-addressed and stable across identical calls", async () => {
		const first = await captureResponsesRequest({
			sessionId: "stable-session",
			applyHints: true,
		});
		const second = await captureResponsesRequest({
			sessionId: "stable-session",
			applyHints: true,
		});
		expect(typeof first.payload?.prompt_cache_key).toBe("string");
		expect(first.payload?.prompt_cache_key).toBe(
			second.payload?.prompt_cache_key,
		);
		expect(first.payload?.prompt_cache_key).not.toBe(
			(
				await captureResponsesRequest({
					sessionId: "other-session",
					applyHints: true,
				})
			).payload?.prompt_cache_key,
		);
	});

	test("registers a Meta-only before_provider_request hook that applies the hints", async () => {
		type RequestHandler = (
			event: { payload: unknown },
			ctx: { model?: { provider: string; id?: string } },
		) => unknown;
		let handler: RequestHandler | undefined;
		metaOAuthProvider({
			registerProvider() {},
			on(event: string, next: unknown) {
				if (event === "before_provider_request") {
					handler = next as RequestHandler;
				}
			},
		} as unknown as ExtensionAPI);
		expect(handler).toBeDefined();

		const other = await handler?.(
			{ payload: { model: "gpt" } },
			{ model: { provider: "openai", id: "gpt" } },
		);
		expect(other).toBeUndefined();

		const meta = await handler?.(
			{ payload: { model: "muse-spark-1.2" } },
			{ model: { provider: META_PROVIDER_ID, id: "muse-spark-1.2" } },
		);
		expect(meta).toMatchObject({
			model: "muse-spark-1.2",
			prompt_cache_retention: "24h",
		});
	});

	// Pi 0.86 runs every in-session refresh with allowNetwork:false, and the
	// only networked caller (pi update --models) does not load extensions. An
	// extension-triggered live pass is also superseded by pi's startup refresh
	// storm, so the extension fetches the catalog itself and re-registers.
	test("discovers the live catalog once per cooldown window", async () => {
		resetCatalogRefreshState();
		const registered: unknown[] = [];
		let authCalls = 0;
		const pi = {
			registerProvider: (_id: string, config: unknown) => {
				registered.push(config);
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			modelRegistry: {
				getProviderAuth: async () => {
					authCalls += 1;
					return { auth: { apiKey: "model-api-key" } };
				},
			},
		} as unknown as Parameters<typeof startLiveCatalogRefresh>[1];
		const fetchMock = (async () =>
			jsonResponse({ data: [{ id: "muse-spark-1.2" }] })) as unknown as typeof fetch;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock;
		try {
			const first = startLiveCatalogRefresh(pi, ctx, 0);
			expect(first).toBeDefined();
			expect(startLiveCatalogRefresh(pi, ctx, 1_000)).toBeUndefined();
			await first;

			expect(authCalls).toBe(1);
			expect(registered).toHaveLength(1);
			expect(registered[0]).toMatchObject({
				api: "openai-responses",
				models: [expect.objectContaining({ id: "muse-spark-1.2" })],
			});

			// Past the 4h cooldown the next session start refreshes again.
			await startLiveCatalogRefresh(pi, ctx, 4 * 60 * 60 * 1000 + 1);
			expect(registered).toHaveLength(2);
			expect(authCalls).toBe(2);
		} finally {
			globalThis.fetch = originalFetch;
			resetCatalogRefreshState();
		}
	});

	test("a failed catalog fetch never breaks session startup", async () => {
		resetCatalogRefreshState();
		const pi = {
			registerProvider: () => {
				throw new Error("should not register");
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			modelRegistry: {
				getProviderAuth: async () => {
					throw new Error("catalog unreachable");
				},
			},
		} as unknown as Parameters<typeof startLiveCatalogRefresh>[1];
		await expect(
			startLiveCatalogRefresh(pi, ctx, 0),
		).resolves.toBeUndefined();
		// The attempt is recorded, so a failure cannot retry-storm on every event.
		expect(shouldRefreshCatalog(1_000)).toBe(false);
		resetCatalogRefreshState();
	});

	test("skips discovery when no Meta key resolves", async () => {
		resetCatalogRefreshState();
		let registered = false;
		const pi = {
			registerProvider: () => {
				registered = true;
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			modelRegistry: {
				getProviderAuth: async () => undefined,
			},
		} as unknown as Parameters<typeof startLiveCatalogRefresh>[1];
		await startLiveCatalogRefresh(pi, ctx, 0);
		expect(registered).toBe(false);
		resetCatalogRefreshState();
	});

	test("stays offline when PI_OFFLINE is set", async () => {
		resetCatalogRefreshState();
		const previous = process.env["PI_OFFLINE"];
		process.env["PI_OFFLINE"] = "1";
		try {
			let called = false;
			const pi = { registerProvider: () => {} } as unknown as ExtensionAPI;
			const ctx = {
				modelRegistry: {
					getProviderAuth: async () => {
						called = true;
						return { auth: { apiKey: "model-api-key" } };
					},
				},
			} as unknown as Parameters<typeof startLiveCatalogRefresh>[1];
			expect(startLiveCatalogRefresh(pi, ctx, 0)).toBeUndefined();
			expect(called).toBe(false);
		} finally {
			if (previous === undefined) delete process.env["PI_OFFLINE"];
			else process.env["PI_OFFLINE"] = previous;
			resetCatalogRefreshState();
		}
	});

	test("requests the live catalog on session start", async () => {
		resetCatalogRefreshState();
		const handlers = new Map<string, unknown>();
		const registered: unknown[] = [];
		metaOAuthProvider({
			registerProvider(_id: string, config?: unknown) {
				if (config) registered.push(config);
			},
			on(event: string, next: unknown) {
				handlers.set(event, next);
			},
		} as unknown as ExtensionAPI);
		const sessionStart = handlers.get("session_start") as
			| ((event: unknown, ctx: unknown) => unknown)
			| undefined;
		expect(sessionStart).toBeTypeOf("function");
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			jsonResponse({
				data: [{ id: "rl-muse-spark-1-3-sglang-playground" }],
			})) as unknown as typeof fetch;
		try {
			await sessionStart?.(
				{ type: "session_start", reason: "startup" },
				{
					modelRegistry: {
						getProviderAuth: async () => ({ auth: { apiKey: "model-api-key" } }),
					},
				},
			);
			// The hook is fire-and-forget so session startup never blocks on Meta;
			// wait for the in-flight pass to settle before asserting.
			const deadline = Date.now() + 5_000;
			let live: unknown[] = [];
			for (;;) {
				live = registered.filter((config) => {
					const models =
						(config as { models?: Array<{ id: string }> }).models ?? [];
					return models.some(
						(model) => model.id === "rl-muse-spark-1-3-sglang-playground",
					);
				});
				if (live.length > 0 || Date.now() > deadline) break;
				await Bun.sleep(25);
			}
			// One re-registration carrying the live ids, after the bundled default.
			expect(live).toHaveLength(1);
		} finally {
			globalThis.fetch = originalFetch;
			resetCatalogRefreshState();
		}
	});

	test("reports Muse as subscription-backed like pi's built-in provider", () => {
		const config = createMetaProviderConfig();
		expect(config.oauth?.isSubscription).toBe(true);
	});
});

function liveCachePrefix(): string {
	const lines: string[] = [
		"This block is a fixed Muse prompt-cache probe. Keep it byte-identical.",
	];
	let n = 0;
	while (lines.join("\n").length < 16_000) {
		n += 1;
		lines.push(
			`${n}. Identical prefix line for prompt-cache measurement across two calls.`,
		);
	}
	return lines.join("\n");
}

function liveCachePayload(model: string): Record<string, unknown> {
	return {
		model,
		prompt_cache_key: LIVE_CACHE_KEY,
		max_output_tokens: 16,
		input: [
			{
				type: "message",
				role: "user",
				content: [
					{
						type: "input_text",
						text: `${liveCachePrefix()}\n\nReply with the single word pong.`,
					},
				],
			},
		],
	};
}

interface LiveResponseUsage {
	input_tokens?: number;
	output_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}

interface LiveResponse {
	usage?: LiveResponseUsage;
}

async function callLiveMetaResponses(
	apiKey: string,
	payload: Record<string, unknown>,
): Promise<LiveResponse> {
	const body = applyMetaResponsesCacheHints({ ...payload, store: false });
	const response = await fetch(`${META_API_BASE_URL}/responses`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const raw = (await response.json()) as LiveResponse;
	if (!response.ok) {
		throw new Error(
			`Meta Responses cache probe failed (HTTP ${response.status}): ${JSON.stringify(raw).slice(0, 500)}`,
		);
	}
	return raw;
}

function usageSummary(raw: LiveResponse): string {
	const input = raw.usage?.input_tokens ?? 0;
	const output = raw.usage?.output_tokens ?? 0;
	const cacheRead = raw.usage?.input_tokens_details?.cached_tokens ?? 0;
	const pct = input > 0 ? Math.round((cacheRead / input) * 100) : 0;
	return `cache=${cacheRead}/${input} (${pct}%) input=${input - cacheRead} output=${output}`;
}

describe("Meta live prompt-cache probe", () => {
	liveCacheTest(
		"second identical Responses call reports cached tokens",
		async () => {
			if (!liveApiKey) throw new Error("PI_META_LIVE_API_KEY is required");
			const payload = liveCachePayload(await resolveLiveCacheModel(liveApiKey));
			const first = await callLiveMetaResponses(liveApiKey, { ...payload });
			let second = await callLiveMetaResponses(liveApiKey, { ...payload });
			let cacheRead = second.usage?.input_tokens_details?.cached_tokens ?? 0;
			if (!cacheRead) {
				await Bun.sleep(2_000);
				second = await callLiveMetaResponses(liveApiKey, { ...payload });
				cacheRead = second.usage?.input_tokens_details?.cached_tokens ?? 0;
			}
			expect(
				second.usage?.input_tokens,
				`first ${usageSummary(first)}`,
			).toBeGreaterThan(1_000);
			expect(
				cacheRead,
				`first ${usageSummary(first)}; second ${usageSummary(second)}`,
			).toBeGreaterThan(0);
		},
		120_000,
	);
});

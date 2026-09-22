/// <reference types="bun-types" />
import { beforeEach, describe, expect, test } from "bun:test";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
	createAssistantMessageEventStream,
	normalizeContext,
} from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import {
	createMetaProviderConfig,
	createMetaStreamSimple,
	DEFAULT_META_RETRY,
	learnFromMetaError,
	bindMetaStreamState,
	META_API_BASE_URL,
	META_PROVIDER_ID,
	metaRetryDelayMs,
	metaTransportRetryEnabled,
	resetMetaStreamState,
	streamMetaSimple,
	type MetaInnerApi,
	type MetaStreamRetryDeps,
} from "../extensions/meta.ts";

/**
 * Observed 2026-09-22 on api.meta.ai: a flooded gateway answers with HTTP 504
 * and this body, which pi-ai folds into `stopReason: "error"`:
 *
 *     meta API error (504): {"code":"gateway_timeout","message":"The response
 *     stream did not start before the server timeout.","param":null,
 *     "type":"server_error"}
 *
 * The extension's provider-seam retry layer must absorb it before pi (and any
 * retry extension) ever sees a failed turn.
 */
const GATEWAY_TIMEOUT =
	'meta API error (504): {"code":"gateway_timeout","message":"The response stream did not start before the server timeout.","param":null,"type":"server_error"}';

function museModel(): Model<"openai-responses"> {
	const fallback = (createMetaProviderConfig().models ?? [])[0];
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

function context() {
	return normalizeContext({
		messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
	});
}

function errorMessage(
	model: Model<"openai-responses">,
	errorMessageText: string,
	stopReason: AssistantMessage["stopReason"] = "error",
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage: errorMessageText,
		timestamp: Date.now(),
	};
}

function startEvent(message: AssistantMessage): AssistantMessageEvent {
	return { type: "start", partial: message };
}

function textEvents(
	message: AssistantMessage,
	text = "Hello",
): AssistantMessageEvent[] {
	message.content = [{ type: "text", text }];
	message.stopReason = "stop";
	return [
		{ type: "text_start", contentIndex: 0, partial: message },
		{ type: "text_delta", contentIndex: 0, delta: text, partial: message },
		{ type: "text_end", contentIndex: 0, content: text, partial: message },
		{ type: "done", reason: "stop", message },
	];
}

/**
 * Scripted inner Responses implementation: each entry is a fresh response.
 * `events` may return raw event lists or throw.
 */
function scriptedInner(
	model: Model<"openai-responses">,
	script: Array<
		| AssistantMessageEvent[]
		| (() => AssistantMessageEvent[] | never)
	>,
): { inner: MetaInnerApi; state: { calls: number } } {
	const state = { calls: 0 };
	const inner: MetaInnerApi = {
		streamSimple() {
			const index = state.calls++;
			const entry = script[index] ?? script[script.length - 1];
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				try {
					const events = typeof entry === "function" ? entry() : entry;
					for (const event of events) stream.push(event);
					stream.end();
				} catch (error) {
					stream.push({
						type: "error",
						reason: "error",
						error:
							error instanceof Error
								? errorMessage(model, error.message)
								: errorMessage(model, String(error)),
					});
					stream.end();
				}
			});
			return stream;
		},
	};
	return { inner, state };
}

/** Drain a stream into a list, resolving only when it terminates. */
async function drain(
	stream: AssistantMessageEventStream,
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function sleepRecorder(): {
	sleep: (ms: number, signal?: AbortSignal) => Promise<boolean>;
	delays: number[];
} {
	const delays: number[] = [];
	return {
		delays,
		sleep: async (ms: number, signal?: AbortSignal) => {
			delays.push(ms);
			return signal?.aborted === true;
		},
	};
}

describe("Meta transient-error classification", () => {
	function message(text: string, stopReason: AssistantMessage["stopReason"] = "error") {
		return errorMessage(museModel(), text, stopReason);
	}

	test("retries the measured gateway_timeout 504 body", async () => {
		const { isRetryableMetaError } = await import("../extensions/meta.ts");
		expect(isRetryableMetaError(message(GATEWAY_TIMEOUT))).toBe(true);
	});

	test("retries pi-ai's transient catalog and Meta capacity wordings", async () => {
		const { isRetryableMetaError } = await import("../extensions/meta.ts");
		for (const text of [
			"meta API error (502): bad gateway",
			"meta API error (503): service unavailable",
			"Service temporarily overloaded",
			"ResourceExhausted",
			"meta API error (429): too many requests",
		]) {
			expect(isRetryableMetaError(message(text))).toBe(true);
		}
	});

	// A 429 can mean a rate limit (transient) or an exhausted subscription
	// (permanent). pi-ai's NON_RETRYABLE catalog wins, so quota never loops.
	test("never retries permanent failures even when they carry a 429", async () => {
		const { isRetryableMetaError } = await import("../extensions/meta.ts");
		for (const text of [
			'meta API error (429): {"code":"insufficient_quota","message":"You exceeded your current quota"}',
			'meta API error (429): GoUsageLimitError',
			"meta API error (402): out of budget",
			"meta API error (429): billing hard limit reached",
		]) {
			expect(isRetryableMetaError(message(text))).toBe(false);
		}
	});

	test("never retries deterministic provider or auth failures", async () => {
		const { isRetryableMetaError } = await import("../extensions/meta.ts");
		for (const text of [
			"meta API error (400): reasoning `encrypted_content` was not issued to this caller",
			'meta API error (404): {"code":"model_not_found","message":"The model does not exist"}',
			"meta API error (401): invalid_api_key",
			"meta API error (400): content filter triggered",
			"meta API error (400): unsupported parameter",
		]) {
			expect(isRetryableMetaError(message(text))).toBe(false);
		}
	});

	// Overflow is recovered by compaction-and-retry, never by re-sending.
	test("never retries context overflow", async () => {
		const { isRetryableMetaError } = await import("../extensions/meta.ts");
		expect(
			isRetryableMetaError(
				message("This model's maximum context length is 1048576 tokens"),
			),
		).toBe(false);
	});

	test("ignores successful and aborted turns", async () => {
		const { isRetryableMetaError } = await import("../extensions/meta.ts");
		expect(isRetryableMetaError(message("", "stop"))).toBe(false);
		expect(isRetryableMetaError(message(GATEWAY_TIMEOUT, "aborted"))).toBe(false);
	});

	test("backoff is exponential with a hard ceiling", () => {
		const config = { maxRetries: 10, minDelayMs: 2_000, maxDelayMs: 30_000 };
		expect(metaRetryDelayMs(1, config)).toBe(2_000);
		expect(metaRetryDelayMs(2, config)).toBe(4_000);
		expect(metaRetryDelayMs(3, config)).toBe(8_000);
		expect(metaRetryDelayMs(9, config)).toBe(30_000);
		expect(metaRetryDelayMs(1, DEFAULT_META_RETRY)).toBe(
			DEFAULT_META_RETRY.minDelayMs,
		);
	});

	test("reads the kill switch from META_TRANSPORT_RETRY", () => {
		expect(metaTransportRetryEnabled({})).toBe(true);
		expect(metaTransportRetryEnabled({ META_TRANSPORT_RETRY: "1" })).toBe(true);
		for (const value of ["0", "false", "FALSE", "no", "off", " off "]) {
			expect(metaTransportRetryEnabled({ META_TRANSPORT_RETRY: value })).toBe(
				false,
			);
		}
	});
});

describe("Meta transparent retry stream", () => {
	beforeEach(() => {
		resetMetaStreamState();
	});

	test("absorbs a 504 storm and hands pi one clean stream", async () => {
		const model = museModel();
		const success = { ...errorMessage(model, ""), stopReason: "stop" as const };
		const { inner, state: callsRef } = scriptedInner(model, [
			[startEvent(errorMessage(model, GATEWAY_TIMEOUT)), { type: "error", reason: "error", error: errorMessage(model, GATEWAY_TIMEOUT) }],
			[startEvent(errorMessage(model, GATEWAY_TIMEOUT)), { type: "error", reason: "error", error: errorMessage(model, GATEWAY_TIMEOUT) }],
			[startEvent(success), ...textEvents(success)],
		]);
		const scheduled: Array<{ attempt: number; delayMs: number }> = [];
		const { sleep, delays } = sleepRecorder();

		const events = await drain(
			streamMetaSimple(model, context(), {}, {
				inner,
				sleep,
				enabled: true,
				onRetryScheduled: (info) =>
					scheduled.push({ attempt: info.attempt, delayMs: info.delayMs }),
			}),
		);

		expect(callsRef.calls).toBe(3);
		expect(delays).toEqual([2_000, 4_000]);
		expect(scheduled).toEqual([
			{ attempt: 1, delayMs: 2_000 },
			{ attempt: 2, delayMs: 4_000 },
		]);
		// Exactly one start and one done: the discarded attempts left no trace.
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
	});

	test("preserves the original error byte-for-byte once the budget is spent", async () => {
		const model = museModel();
		const failure = [startEvent(errorMessage(model, GATEWAY_TIMEOUT)), { type: "error" as const, reason: "error" as const, error: errorMessage(model, GATEWAY_TIMEOUT) }];
		const { inner, state: callsRef } = scriptedInner(model, [failure, failure, failure, failure, failure]);
		const exhausted: Array<{ attempts: number; errorMessage: string }> = [];
		const { sleep } = sleepRecorder();

		const events = await drain(
			streamMetaSimple(model, context(), {}, {
				inner,
				sleep,
				enabled: true,
				config: { ...DEFAULT_META_RETRY, maxRetries: 3 },
				onRetryExhausted: (info) => exhausted.push(info),
			}),
		);

		expect(callsRef.calls).toBe(4);
		expect(exhausted).toHaveLength(1);
		expect(exhausted[0]?.attempts).toBe(4);
		expect(exhausted[0]?.errorMessage).toBe(GATEWAY_TIMEOUT);
		// Same shape pi would get without the layer: one start, one error.
		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		const terminal = events.at(-1);
		if (terminal?.type !== "error") throw new Error("expected an error event");
		expect(terminal.reason).toBe("error");
		expect(terminal.error.errorMessage).toBe(GATEWAY_TIMEOUT);
	});

	test("never replays an attempt that already delivered content to pi", async () => {
		const model = museModel();
		const partial = errorMessage(model, "");
		const { inner, state: callsRef } = scriptedInner(model, [
			[
				startEvent(partial),
				{ type: "text_start", contentIndex: 0, partial },
				{ type: "text_delta", contentIndex: 0, delta: "Hello", partial },
				{ type: "error", reason: "error", error: errorMessage(model, GATEWAY_TIMEOUT) },
			],
		]);
		const { sleep, delays } = sleepRecorder();

		const events = await drain(
			streamMetaSimple(model, context(), {}, { inner, sleep, enabled: true }),
		);

		expect(callsRef.calls).toBe(1);
		expect(delays).toHaveLength(0);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"error",
		]);
	});

	test("treats a stream that ends without a terminal event as retryable", async () => {
		const model = museModel();
		const partial = errorMessage(model, "");
		const { inner, state: callsRef } = scriptedInner(model, [
			[startEvent(partial)],
			[startEvent(partial), ...textEvents(partial, "Recovered")],
		]);
		const { sleep } = sleepRecorder();

		const events = await drain(
			streamMetaSimple(model, context(), {}, { inner, sleep, enabled: true }),
		);

		expect(callsRef.calls).toBe(2);
		expect(events.at(-1)?.type).toBe("done");
	});

	test("does not retry permanent failures", async () => {
		const model = museModel();
		const notFound = 'meta API error (404): {"code":"model_not_found","message":"unknown model"}';
		const { inner, state: callsRef } = scriptedInner(model, [
			[startEvent(errorMessage(model, notFound)), { type: "error", reason: "error", error: errorMessage(model, notFound) }],
		]);
		const { sleep, delays } = sleepRecorder();

		const events = await drain(
			streamMetaSimple(model, context(), {}, { inner, sleep, enabled: true }),
		);

		expect(callsRef.calls).toBe(1);
		expect(delays).toHaveLength(0);
		expect(events.at(-1)?.type).toBe("error");
	});

	test("learns that a key is not entitled to encrypted reasoning", async () => {
		const model = museModel();
		const denial =
			"meta API error (400): reasoning `encrypted_content` was not issued to this caller";
		const { inner } = scriptedInner(model, [
			[startEvent(errorMessage(model, denial)), { type: "error", reason: "error", error: errorMessage(model, denial) }],
		]);
		const { sleep } = sleepRecorder();

		await drain(
			streamMetaSimple(model, context(), { apiKey: "learn-key" }, {
				inner,
				sleep,
				enabled: true,
			}),
		);

		const { encryptedReasoningEntitlement, probeEncryptedReasoningEntitlement } =
			await import("../extensions/meta.ts");
		// The probe entitlement is a separate cache; assert the learning path
		// through the public accessor the request hook consults.
		expect(typeof probeEncryptedReasoningEntitlement).toBe("function");
		expect(encryptedReasoningEntitlement("learn-key", model.id)).toBe(false);
	});

	test("kicks a catalog repair when Meta reports an unknown model", () => {
		const refreshes: number[] = [];
		resetMetaStreamState();
		bindMetaStreamState({ refreshCatalog: () => refreshes.push(Date.now()) });
		learnFromMetaError(
			'meta API error (404): {"code":"model_not_found"}',
			"muse-spark-1.3",
			"some-key",
		);
		expect(refreshes).toHaveLength(1);
		// A retryable-but-unrelated failure never triggers a catalog refetch.
		learnFromMetaError(GATEWAY_TIMEOUT, "muse-spark-1.3", "some-key");
		expect(refreshes).toHaveLength(1);
	});

	test("disabled retry forwards exactly one attempt", async () => {
		const model = museModel();
		const { inner, state: callsRef } = scriptedInner(model, [
			[startEvent(errorMessage(model, GATEWAY_TIMEOUT)), { type: "error", reason: "error", error: errorMessage(model, GATEWAY_TIMEOUT) }],
			[startEvent(errorMessage(model, "")), ...textEvents(errorMessage(model, ""))],
		]);
		const exhausted: number[] = [];
		const { sleep, delays } = sleepRecorder();

		const events = await drain(
			streamMetaSimple(model, context(), {}, {
				inner,
				sleep,
				enabled: false,
				onRetryExhausted: (info) => exhausted.push(info.attempts),
			}),
		);

		expect(callsRef.calls).toBe(1);
		expect(delays).toHaveLength(0);
		expect(exhausted).toHaveLength(0);
		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
	});

	test("aborting during the backoff reports an aborted turn", async () => {
		const model = museModel();
		const { inner, state: callsRef } = scriptedInner(model, [
			[startEvent(errorMessage(model, GATEWAY_TIMEOUT)), { type: "error", reason: "error", error: errorMessage(model, GATEWAY_TIMEOUT) }],
		]);
		const controller = new AbortController();
		const sleep = async (): Promise<boolean> => {
			controller.abort();
			return true;
		};

		const events = await drain(
			streamMetaSimple(model, context(), { signal: controller.signal }, {
				inner,
				sleep,
				enabled: true,
			}),
		);

		expect(callsRef.calls).toBe(1);
		const terminal = events.at(-1);
		if (terminal?.type !== "error") throw new Error("expected an error event");
		expect(terminal.reason).toBe("aborted");
		expect(terminal.error.stopReason).toBe("aborted");
		expect(terminal.error.errorMessage).toBeUndefined();
	});

	test("keeps pi's stream contract when the inner API throws", async () => {
		const model = museModel();
		const inner: MetaInnerApi = {
			streamSimple() {
				throw new Error("inner exploded synchronously");
			},
		};

		const events = await drain(
			streamMetaSimple(model, context(), {}, { inner, enabled: true }),
		);

		expect(events.map((event) => event.type)).toEqual(["error"]);
		const terminal = events.at(-1);
		if (terminal?.type !== "error") throw new Error("expected an error event");
		expect(terminal.error.errorMessage).toBe("inner exploded synchronously");
	});

	test("wires the retry layer into the provider config", () => {
		const config = createMetaProviderConfig();
		expect(config.api).toBe("openai-responses");
		expect(typeof config.streamSimple).toBe("function");
	});
});
describe("Meta retry exhaustion notifications", () => {
	beforeEach(() => {
		resetMetaStreamState();
	});

	test("notifies once per distinct error and stays silent without a UI", async () => {
		const model = museModel();
		const failureEvents = [
			startEvent(errorMessage(model, GATEWAY_TIMEOUT)),
			{ type: "error" as const, reason: "error" as const, error: errorMessage(model, GATEWAY_TIMEOUT) },
		];
		const { inner } = scriptedInner(model, Array(8).fill(failureEvents));
		const { sleep } = sleepRecorder();
		const notes: Array<{ message: string; type: string }> = [];
		bindMetaStreamState({
			notify: (message, type) => notes.push({ message, type }),
		});

		const handler = createMetaStreamSimple({ inner, sleep, enabled: true });
		for (let pass = 0; pass < 2; pass++) {
			const events: AssistantMessageEvent[] = [];
			for await (const event of handler(model, context(), {})) events.push(event);
			expect(events.at(-1)?.type).toBe("error");
		}

		// Three retries per pass, then one "giving up" notice deduped across passes.
		expect(notes.filter((n) => n.type === "info")).toHaveLength(6);
		expect(notes.filter((n) => n.type === "warning")).toHaveLength(1);
		expect(
			notes.find((n) => n.type === "warning")?.message,
		).toContain("giving up after 4 attempts");
		expect(notes[0]?.message).toContain("gateway_timeout");

		// Headless: no UI binding, so nothing is emitted and nothing throws.
		resetMetaStreamState();
		for await (const _event of handler(model, context(), {})) {
			// Drain the scripted failures.
		}
		expect(notes).toHaveLength(7);
	});
});

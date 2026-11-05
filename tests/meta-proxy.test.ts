/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
	connect as connectTcp,
	createServer as createTcpServer,
	type Server as TcpServer,
} from "node:net";
import type { AddressInfo } from "node:net";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
	bindMetaStreamState,
	createMetaProxyFetch,
	META_PROXY_QUARANTINE_MS,
	metaProxyEndpoints,
	metaProxyFetch,
	metaProxySources,
	parseMetaProxy,
	resetMetaProxyFailure,
	resetMetaProxyFetch,
	resetMetaProxyNotices,
	resetMetaStreamState,
	streamMetaSimple,
} from "../extensions/meta.ts";

/**
 * Measured 2026-11-03: Meta gates the Model API by exit geography. From a
 * Georgian residential line with a working key, `GET /v1/models` answered
 * `200 {"data":[]}` and every chat id answered `404 model_not_found`; the same
 * key through a US residential exit listed nine ids and completed turns. Pi's
 * proxy is process-wide, so `META_PROXY` / `META_PROXIES` give this provider its
 * own tunnel — the same split `pi-nvidia-plus` uses for `NVIDIA_NIM_PROXY` /
 * `NVIDIA_NIM_PROXIES`, minus the file source.
 */
const servers: Server[] = [];
const tcpServers: TcpServer[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.close();
	resetMetaProxyFetch();
	resetMetaProxyNotices();
	resetMetaProxyFailure();
	resetMetaStreamState();
	delete process.env["META_PROXY"];
	delete process.env["META_PROXIES"];
});

function startProxy(
	handler: (authority: string, call: number) => number,
): Promise<{ url: string; see: string[] }> {
	const seen: string[] = [];
	const server = createServer();
	server.on("connect", (req, socket) => {
		const authority = req.url ?? "";
		seen.push(`${req.headers["proxy-authorization"] ?? "-"} ${authority}`);
		const status = handler(authority, seen.length);
		socket.write(`HTTP/1.1 ${status} Nope\r\n\r\n`);
		socket.destroy();
	});
	servers.push(server);
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({ url: `http://127.0.0.1:${port}`, see: seen });
		});
	});
}

/**
 * A proxy that actually tunnels: it accepts every `CONNECT` and dials a fixed
 * local port, which is how the TLS leg and the HTTP-over-tunnel request can be
 * exercised without reaching Meta.
 */
function startTunnelingProxy(
	targetPort: number,
): Promise<{ url: string; connects: number }> {
	const state = { url: "", connects: 0 };
	const server = createServer();
	server.on("connect", (req, client, head) => {
		state.connects += 1;
		const upstream = connectTcp(targetPort, "127.0.0.1", () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) upstream.write(head);
			client.pipe(upstream);
			upstream.pipe(client);
		});
		upstream.on("error", () => client.destroy());
		client.on("error", () => upstream.destroy());
		void req;
	});
	servers.push(server);
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			state.url = `http://127.0.0.1:${port}`;
			resolve(state);
		});
	});
}

const fixtureDir = new URL("./fixtures/", import.meta.url);
const testCert = readFileSync(new URL("meta-test-cert.pem", fixtureDir), "utf8");
const testKey = readFileSync(new URL("meta-test-key.pem", fixtureDir), "utf8");

describe("META_PROXY parsing", () => {
	test("accepts a bare host:port and assumes http://", () => {
		const parsed = parseMetaProxy("1.2.3.4:8870");
		expect(parsed.error).toBeUndefined();
		expect(parsed.href).toBe("http://1.2.3.4:8870/");
		expect(parsed.display).toBe("1.2.3.4:8870");
	});

	// What a proxy seller actually hands out: `host:port:user:pass`.
	test("accepts the host:port:user:pass line a seller prints", () => {
		const parsed = parseMetaProxy("147.68.215.226:3128:xyz377:9xhnno828c02m0bx");
		expect(parsed.error).toBeUndefined();
		expect(parsed.display).toBe("147.68.215.226:3128");
		const url = new URL(parsed.href!);
		expect(url.username).toBe("xyz377");
		expect(url.password).toBe("9xhnno828c02m0bx");
	});

	test("keeps credentials in the identity and out of the display name", () => {
		const parsed = parseMetaProxy("user:pass@example.net:3128");
		expect(parsed.href).toContain("user:pass@example.net:3128");
		expect(parsed.display).toBe("example.net:3128");
	});

	test("refuses the schemes this transport cannot speak, naming the variable", () => {
		expect(parseMetaProxy("https://example.net:3128").error).toContain(
			"must be an http:// CONNECT proxy",
		);
		expect(parseMetaProxy("socks5://example.net:1080").error).toContain(
			"not supported",
		);
	});

	test("redacts credentials in the error text", () => {
		const parsed = parseMetaProxy("secret:hunter2@");
		expect(parsed.error).toContain("//***@");
		expect(parsed.error).not.toContain("hunter2");
	});

	test("reads META_PROXIES first, then META_PROXY", () => {
		expect(metaProxySources({})).toEqual([]);
		expect(metaProxySources({ META_PROXY: " http://a:1 " })).toEqual([
			"http://a:1",
		]);
		expect(
			metaProxySources({
				META_PROXY: "http://a:1",
				META_PROXIES: "http://b:2, http://c:3,,",
			}),
		).toEqual(["http://b:2", "http://c:3"]);
	});

	test("parses every endpoint and fails loudly on the first bad one", () => {
		expect(
			metaProxyEndpoints({ META_PROXIES: "1.2.3.4:8870,5.6.7.8:3128" }),
		).toHaveLength(2);
		expect(() =>
			metaProxyEndpoints({ META_PROXIES: "1.2.3.4:8870,socks5://x:1" }),
		).toThrow("must be an http:// CONNECT proxy");
	});

	test("caches one transport per endpoint set and rebuilds when it changes", () => {
		const first = metaProxyFetch({ META_PROXY: "http://127.0.0.1:1" });
		const again = metaProxyFetch({ META_PROXY: "http://127.0.0.1:1" });
		const other = metaProxyFetch({ META_PROXY: "http://127.0.0.1:2" });

		expect(first).toBeDefined();
		expect(again).toBe(first);
		expect(other).not.toBe(first);
		expect(metaProxyFetch({})).toBeUndefined();
	});
});

describe("META_PROXY transport", () => {
	test("refuses plain-http targets instead of silently going direct", async () => {
		const proxy = await startProxy(() => 200);
		const proxied = createMetaProxyFetch(proxy.url);

		await expect(proxied("http://api.meta.ai/v1/models")).rejects.toThrow(
			"only tunnels https targets",
		);
	});

	test("surfaces a refused CONNECT with the proxy status", async () => {
		const proxy = await startProxy(() => 407);
		const proxied = createMetaProxyFetch(proxy.url);

		await expect(
			proxied("https://api.meta.ai/v1/models", {
				headers: { authorization: "Bearer key" },
			}),
		).rejects.toThrow("proxy CONNECT refused with HTTP 407");
		// The tunnel is addressed by host:port and carries the proxy credentials.
		expect(proxy.see).toEqual(["- api.meta.ai:443"]);
	});

	test("sends the proxy credentials the URL carries", async () => {
		const proxy = await startProxy(() => 403);
		const proxied = createMetaProxyFetch(
			proxy.url.replace("http://", "http://alice:s3cret@"),
		);

		await expect(proxied("https://api.meta.ai/v1/models")).rejects.toThrow(
			"HTTP 403",
		);
		expect(proxy.see[0]).toStartWith("Basic ");
		expect(
			Buffer.from(proxy.see[0]!.split(" ")[1]!, "base64").toString("utf8"),
		).toBe("alice:s3cret");
	});

	// Measured with the operator's two exits: one answered 8/8, the other dropped
	// two of three requests. A dead exit must cost one attempt, not the turn.
	// A dead exit that swallows the connection used to hang the turn until pi's
	// own timeout; measured 90 s on a closed residential port.
	test("gives up on an exit that never answers the CONNECT", async () => {
		const silent = createTcpServer(() => {});
		tcpServers.push(silent);
		const port = await new Promise<number>((resolve) => {
			silent.listen(0, "127.0.0.1", () =>
				resolve((silent.address() as AddressInfo).port),
			);
		});
		const proxied = createMetaProxyFetch(`127.0.0.1:${port}`, {
			connectTimeoutMs: 80,
		});

		await expect(proxied("https://api.meta.ai/v1/models")).rejects.toThrow(
			"timed out after 80 ms",
		);
	});

	test("falls through to the next endpoint when one refuses the tunnel", async () => {
		const dead = await startProxy(() => 502);
		const alive = await startProxy(() => 403);
		const proxied = createMetaProxyFetch([dead.url, alive.url]);

		await expect(proxied("https://api.meta.ai/v1/models")).rejects.toThrow(
			"HTTP 403",
		);
		expect(dead.see).toHaveLength(1);
		expect(alive.see).toHaveLength(1);
	});

	// A dead exit must not be paid for on every request, and the quarantine must
	// expire instead of becoming a permanent denylist.
	test("quarantines a dead endpoint, then gives it another chance", async () => {
		let clock = 1_000_000;
		const dead = await startProxy(() => 502);
		const alive = await startProxy(() => 403);
		const proxied = createMetaProxyFetch([dead.url, alive.url], {
			now: () => clock,
		});

		await expect(proxied("https://api.meta.ai/v1/models")).rejects.toThrow();
		expect(dead.see).toHaveLength(1);
		expect(alive.see).toHaveLength(1);

		// Still inside the window and nothing else is ready: both are retried
		// rather than failing the turn on a bad minute.
		clock += 1_000;
		await expect(proxied("https://api.meta.ai/v1/models")).rejects.toThrow();
		expect(dead.see).toHaveLength(2);

		// The window closed: the dead endpoint is a candidate again.
		clock += META_PROXY_QUARANTINE_MS;
		await expect(proxied("https://api.meta.ai/v1/models")).rejects.toThrow();
		expect(dead.see).toHaveLength(3);
		expect(alive.see).toHaveLength(3);
	});

	// A dead exit must be visible in the UI: otherwise the user reads the failed
	// turn as "Meta is broken" while the real cause is a proxy nobody mentioned.
	test("warns when the only endpoint refuses the tunnel", async () => {
		const notices: Array<{ message: string; type: string }> = [];
		bindMetaStreamState({
			notify: (message, type) => notices.push({ message, type }),
		});
		const proxy = await startProxy(() => 502);
		const proxied = createMetaProxyFetch(proxy.url);

		await expect(proxied("https://api.meta.ai/v1/models")).rejects.toThrow();

		const text = notices.map((notice) => notice.message).join("\n");
		expect(text).toContain(`proxy 127.0.0.1:${new URL(proxy.url).port} failed`);
		expect(text).toContain("no endpoint left");
		expect(text).toContain("no proxy endpoint is reachable");
		expect(text).toContain("META_PROXY");
		expect(notices.some((notice) => notice.type === "error")).toBe(true);
	});

	test("names the endpoint it falls back to", async () => {
		const notices: string[] = [];
		bindMetaStreamState({ notify: (message) => notices.push(message) });
		const dead = await startProxy(() => 500);
		const alive = await startProxy(() => 403);
		const proxied = createMetaProxyFetch([dead.url, alive.url]);

		await expect(proxied("https://api.meta.ai/v1/models")).rejects.toThrow();

		expect(notices.join("\n")).toContain(
			`trying the next endpoint (127.0.0.1:${new URL(alive.url).port})`,
		);
	});

	test("does not repeat the same warning on every request", async () => {
		const notices: string[] = [];
		bindMetaStreamState({ notify: (message) => notices.push(message) });
		const proxy = await startProxy(() => 502);
		const proxied = createMetaProxyFetch(proxy.url);

		await expect(proxied("https://api.meta.ai/v1/models")).rejects.toThrow();
		await expect(proxied("https://api.meta.ai/v1/models")).rejects.toThrow();

		// One "endpoint failed" plus one "nothing reachable", not four.
		expect(notices).toHaveLength(2);
	});

	// pi retries whatever its classifier believes is transient, and the raw socket
	// error ("getaddrinfo ENOTFOUND …") is in that set — measured: a dead exit
	// against this host's `retry.maxRetries: 10` hung for 90 s. The message the
	// retry layer emits must therefore be one pi stops on.
	test("a dead proxy ends the turn with a message pi will not retry", async () => {
		const model = {
			id: "muse-spark-1.3",
			name: "Muse Spark 1.3",
			provider: "meta",
			api: "openai-responses",
			baseUrl: "https://api.meta.ai/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
		} as never;
		const context = {
			messages: [{ role: "user", content: "say pong" }],
		} as never;

		const stream = streamMetaSimple(
			model,
			context,
			{
				apiKey: "dead-exit",
				fetch: createMetaProxyFetch("127.0.0.1:9:u:p", {
					connectTimeoutMs: 200,
				}),
			},
			{ config: { maxRetries: 0, minDelayMs: 1, maxDelayMs: 1 } },
		);

		let terminal: { type?: string; error?: unknown } = {};
		for await (const event of stream) terminal = event as never;

		expect(terminal.type).toBe("error");
		const message = (terminal as { error: { errorMessage?: string } }).error;
		expect(message.errorMessage).toContain("META_PROXY endpoint");
		expect(message.errorMessage).toContain("META_PROXY/META_PROXIES");
		expect(isRetryableAssistantError(message as never)).toBe(false);
	});

	test("a proxy that answers anything is healthy, whatever the status", async () => {
		const proxy = await startProxy(() => 403);
		let clock = 5_000;
		const proxied = createMetaProxyFetch(proxy.url, { now: () => clock });

		await expect(proxied("https://api.meta.ai/v1/models")).rejects.toThrow();
		// Contact happened, so the endpoint is not quarantined: the next request
		// goes to it again in the same window.
		clock += 1_000;
		await expect(proxied("https://api.meta.ai/v1/models")).rejects.toThrow();

		expect(proxy.see).toHaveLength(2);
		expect(META_PROXY_QUARANTINE_MS).toBe(60_000);
	});

	// The `socket hang up` reports come from this shape: the tunnel is up and the
	// *target* drops the connection before the first response byte. Blaming the
	// exit for that is wrong twice — it quarantines a healthy endpoint, and it
	// replays the request against the next exit, so a POST reaches Meta twice.
	test("a target that hangs up after the tunnel is not blamed on the exit", async () => {
		const notices: string[] = [];
		bindMetaStreamState({ notify: (message) => notices.push(message) });
		let calls = 0;
		const tls = createHttpsServer(
			{ cert: testCert, key: testKey },
			(req, res) => {
				calls += 1;
				if (calls === 2) {
					// Hang up before a single response byte.
					req.socket.destroy();
					return;
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [] }));
			},
		);
		servers.push(tls as unknown as Server);
		await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
		const tlsPort = (tls.address() as AddressInfo).port;

		const unusedExit = await startProxy(() => 502);
		const proxy = await startTunnelingProxy(tlsPort);
		const proxied = createMetaProxyFetch([proxy.url, unusedExit.url], {
			ca: testCert,
		});

		const first = await proxied(`https://meta.test:${tlsPort}/v1/models`);
		expect(first.status).toBe(200);
		await first.text();

		const failure = await proxied(`https://meta.test:${tlsPort}/v1/models`).catch(
			(error: Error) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).not.toContain("META_PROXY endpoint");
		expect(notices).toEqual([]);
		// No failover: the request was not replayed against the second exit.
		expect(unusedExit.see).toHaveLength(0);
		expect(proxy.connects).toBe(2);

		// The exit was never quarantined: the very next request goes to it.
		const third = await proxied(`https://meta.test:${tlsPort}/v1/models`);
		expect(third.status).toBe(200);
		await third.text();
		expect(unusedExit.see).toHaveLength(0);
	});

	// Measured 2026-11-04: one blink of the whole list (both exits refusing at
	// CONNECT) killed a turn that a second pass would have saved. One extra pass,
	// then the terminal message pi will not retry.
	test("a whole exit list failing at CONNECT gets exactly one more pass", async () => {
		const model = {
			id: "muse-spark-1.3",
			name: "Muse Spark 1.3",
			provider: "meta",
			api: "openai-responses",
			baseUrl: "https://api.meta.ai/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
		} as never;
		const dead = await startProxy(() => 502);
		const delays: number[] = [];
		const retries: number[] = [];
		resetMetaProxyFetch();
		resetMetaProxyNotices();
		resetMetaProxyFailure();

		const stream = streamMetaSimple(
			model,
			{ messages: [{ role: "user", content: "say pong" }] } as never,
			{ apiKey: "dead-exit" },
			{
				env: { META_PROXY: dead.url },
				sleep: async (delayMs: number) => {
					delays.push(delayMs);
					return false;
				},
				onRetryScheduled: (info) => retries.push(info.attempt),
			},
		);

		let terminal: { type?: string; error?: unknown } = {};
		for await (const event of stream) terminal = event as never;

		// One retry after the first exhausted list, then the verdict.
		expect(retries).toEqual([1]);
		expect(delays).toEqual([500]);
		expect(dead.see).toHaveLength(2);
		expect(terminal.type).toBe("error");
		const message = (terminal as { error: { errorMessage?: string } }).error;
		expect(message.errorMessage).toContain("META_PROXY endpoint");
		expect(isRetryableAssistantError(message as never)).toBe(false);
	});

	// Same class, different wording: an exit that answers the CONNECT with a 5xx.
	// pi's classifier retries anything carrying 502/503/504, so the digits must
	// not ride in the message pi sees — the status stays in the warning only.
	test("a 5xx CONNECT answer reaches pi without a retryable status code", async () => {
		const model = {
			id: "muse-spark-1.3",
			name: "Muse Spark 1.3",
			provider: "meta",
			api: "openai-responses",
			baseUrl: "https://api.meta.ai/v1",
			reasoning: true,
			input: ["text"],
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
		} as never;
		const notices: string[] = [];
		bindMetaStreamState({ notify: (message) => notices.push(message) });
		const proxy = await startProxy(() => 502);
		resetMetaProxyFetch();
		resetMetaProxyNotices();
		resetMetaProxyFailure();

		const stream = streamMetaSimple(
			model,
			{ messages: [{ role: "user", content: "say pong" }] } as never,
			{ apiKey: "bad-exit" },
			{
				env: { META_PROXY: proxy.url },
				sleep: async () => false,
			},
		);
		let terminal: { type?: string; error?: unknown } = {};
		for await (const event of stream) terminal = event as never;

		const message = (terminal as { error: { errorMessage?: string } }).error;
		expect(message.errorMessage).toContain("META_PROXY endpoint");
		expect(message.errorMessage).toContain(
			"answered the CONNECT handshake with an HTTP error",
		);
		expect(message.errorMessage).not.toContain("502");
		expect(isRetryableAssistantError(message as never)).toBe(false);
		// The exact code is still visible to the user, in the warning.
		expect(notices.join("\n")).toContain("HTTP 502");
	});
});

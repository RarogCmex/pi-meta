/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
	createMetaProxyFetch,
	META_PROXY_QUARANTINE_MS,
	metaProxyEndpoints,
	metaProxyFetch,
	metaProxySources,
	parseMetaProxy,
	resetMetaProxyFetch,
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

afterEach(() => {
	for (const server of servers.splice(0)) server.close();
	resetMetaProxyFetch();
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
});

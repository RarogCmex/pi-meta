/// <reference types="bun-types" />
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
	createMetaProxyFetch,
	metaProxyFetch,
	metaProxyUrl,
	resetMetaProxyFetch,
} from "../extensions/meta.ts";

/**
 * Measured 2026-11-03: Meta gates the Model API by exit geography. From a
 * Georgian residential line with a working key, `GET /v1/models` answered
 * `200 {"data":[]}` and every chat id answered `404 model_not_found`; the same
 * key through a US residential exit listed nine ids and completed turns. Pi's
 * proxy is process-wide, so `META_PROXY_URL` gives this provider its own
 * tunnel. These tests cover the seams that do not need a real proxy: URL
 * resolution, the shapes the transport refuses, and a proxy that says no.
 */
const servers: Server[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.close();
	resetMetaProxyFetch();
	delete process.env["META_PROXY_URL"];
});

function startProxy(
	handler: (authority: string) => number,
): Promise<{ url: string; see: string[] }> {
	const seen: string[] = [];
	const server = createServer();
	server.on("connect", (req, socket) => {
		const authority = req.url ?? "";
		seen.push(`${req.headers["proxy-authorization"] ?? "-"} ${authority}`);
		const status = handler(authority);
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

describe("META_PROXY_URL", () => {
	test("reads the proxy URL from the environment, trimmed", () => {
		expect(metaProxyUrl({})).toBeUndefined();
		expect(metaProxyUrl({ META_PROXY_URL: "   " })).toBeUndefined();
		expect(
			metaProxyUrl({ META_PROXY_URL: "  http://user:pw@127.0.0.1:3128  " }),
		).toBe("http://user:pw@127.0.0.1:3128");
	});

	test("caches one transport per URL and rebuilds when it changes", () => {
		const first = metaProxyFetch({ META_PROXY_URL: "http://127.0.0.1:1" });
		const again = metaProxyFetch({ META_PROXY_URL: "http://127.0.0.1:1" });
		const other = metaProxyFetch({ META_PROXY_URL: "http://127.0.0.1:2" });

		expect(first).toBeDefined();
		expect(again).toBe(first);
		expect(other).not.toBe(first);
		expect(metaProxyFetch({})).toBeUndefined();
	});

	test("refuses a proxy URL it cannot tunnel through", () => {
		expect(() => createMetaProxyFetch("https://127.0.0.1:3128")).toThrow(
			"must be an http:// CONNECT proxy",
		);
	});

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
});

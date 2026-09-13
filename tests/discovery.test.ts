import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test, { after, before } from "node:test";
import { discoverModels, DiscoveryError, parseModelsPayload } from "../src/discovery.js";

let server: Server;
let baseURL: string;

before(async () => {
  server = createServer((request, response) => {
    if (request.url === "/v1/models" && request.headers.authorization === "Bearer test-key") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            { id: "ocg/muse-spark-1.3-contributor" },
            { id: "ocg/muse-spark-1.3-contributor" },
            { id: "" },
            { id: " bad" },
            { id: "bad\nmodel" },
            { id: 42 },
          ],
        }),
      );
      return;
    }

    if (request.url === "/v1/slow-models") {
      setTimeout(() => response.end('{"data":[]}'), 100);
      return;
    }

    response.statusCode = 401;
    response.end("test-key must never appear in an error");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind to TCP");
  baseURL = `http://127.0.0.1:${address.port}/v1`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("parses, filters, deduplicates, and preserves model IDs", () => {
  assert.deepEqual(
    parseModelsPayload({
      data: [
        { id: "ocg/muse-spark-1.3-contributor" },
        { id: "ocg/muse-spark-1.3-contributor" },
        { id: "valid/model" },
        { id: "" },
        { id: " bad" },
        { id: "bad\u0000model" },
        {},
      ],
    }),
    ["ocg/muse-spark-1.3-contributor", "valid/model"],
  );
});

test("rejects malformed and over-count payloads", () => {
  assert.throws(() => parseModelsPayload({ models: [] }), DiscoveryError);
  assert.throws(() => parseModelsPayload({ data: [{ id: "a" }, { id: "b" }] }, 1), /more than 1/u);
});

test("discovers models through a mock HTTP server with Bearer auth", async () => {
  const models = await discoverModels({ apiKey: "test-key", baseURL });
  assert.deepEqual(models, ["ocg/muse-spark-1.3-contributor"]);
});

test("times out discovery without leaking the API key", async () => {
  const fetcher: typeof fetch = (_input, init) =>
    fetch(`${baseURL}/slow-models`, { ...init, signal: init?.signal });

  await assert.rejects(
    discoverModels(
      { apiKey: "test-key", baseURL },
      { fetch: fetcher, timeoutMs: 10 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.match(error.message, /timed out/u);
      assert.doesNotMatch(error.message, /test-key/u);
      return true;
    },
  );
});

test("does not include response content or the API key in HTTP errors", async () => {
  await assert.rejects(
    discoverModels({ apiKey: "wrong-key", baseURL }),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.message, "9router model discovery returned HTTP 401");
      assert.doesNotMatch(error.message, /wrong-key|test-key/u);
      return true;
    },
  );
});

test("caps the response body size", async () => {
  const fetcher: typeof fetch = async () => new Response('{"data":[]}', { status: 200 });
  await assert.rejects(
    discoverModels({ apiKey: "test-key", baseURL }, { fetch: fetcher, maxBytes: 5 }),
    /too large/u,
  );
});

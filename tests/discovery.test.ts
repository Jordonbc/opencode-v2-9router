import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test, { after, before } from "node:test";
import {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  MAX_DISCOVERY_BYTES,
  MAX_MODEL_ID_LENGTH,
  MAX_MODELS,
  discoverModels,
  DiscoveryError,
  parseModelsPayload,
} from "../src/discovery.js";

let server: Server;
let baseURL: string;

before(async () => {
  server = createServer((request, response) => {
    if (request.url === "/v1/models" && request.headers.authorization === "Bearer test-key") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            {
              id: "ocg/muse-spark-1.3-contributor",
              context_length: 1_000_000,
              max_completion_tokens: 131_072,
              capabilities: { reasoning: true, thinkingCanDisable: true },
            },
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

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
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

test("exposes the documented discovery limits", () => {
  assert.equal(DEFAULT_DISCOVERY_TIMEOUT_MS, 5_000);
  assert.equal(MAX_DISCOVERY_BYTES, 1_048_576);
  assert.equal(MAX_MODELS, 1_000);
  assert.equal(MAX_MODEL_ID_LENGTH, 512);
  assert.equal(new DiscoveryError("x").name, "DiscoveryError");
});

test("parses, filters, deduplicates, and preserves model IDs", () => {
  const nulModel = `bad${String.fromCharCode(0)}model`;
  assert.deepEqual(
    parseModelsPayload({
      data: [
        {
          id: "ocg/muse-spark-1.3-contributor",
          context_length: 1_000_000,
          max_completion_tokens: 131_072,
          capabilities: { reasoning: true, thinkingCanDisable: true },
        },
        { id: "ocg/muse-spark-1.3-contributor" },
        { id: "valid/model" },
        { id: "" },
        { id: " bad" },
        { id: nulModel },
        {},
      ],
    }),
    {
      models: [
        {
          id: "ocg/muse-spark-1.3-contributor",
          reasoning: true,
          thinkingCanDisable: true,
          contextLimit: 1_000_000,
          outputLimit: 131_072,
        },
        { id: "valid/model", reasoning: false, thinkingCanDisable: false },
      ],
      dropped: 0,
    },
  );
});

test("rejects malformed payloads", () => {
  assert.throws(() => parseModelsPayload({ models: [] }), DiscoveryError);
});

test("truncates payloads beyond maxModels instead of failing", () => {
  const result = parseModelsPayload({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] }, 2);
  assert.deepEqual(result.models, [
    { id: "a", reasoning: false, thinkingCanDisable: false },
    { id: "b", reasoning: false, thinkingCanDisable: false },
  ]);
  assert.equal(result.dropped, 1);

  // Duplicates of already-kept IDs don't count as dropped.
  const withDupes = parseModelsPayload(
    { data: [{ id: "a" }, { id: "b" }, { id: "a" }, { id: "bad\n" }, { id: "c" }] },
    2,
  );
  assert.deepEqual(
    withDupes.models.map((model) => model.id),
    ["a", "b"],
  );
  assert.equal(withDupes.dropped, 1);
});

test("rejects every non-object payload shape", () => {
  for (const payload of [null, undefined, "data", 42, [], { data: null }, { data: "x" }, {}]) {
    assert.throws(() => parseModelsPayload(payload), DiscoveryError);
  }
});

test("accepts an empty model list and an exact maxModels boundary", () => {
  assert.deepEqual(parseModelsPayload({ data: [] }), { models: [], dropped: 0 });
  assert.deepEqual(parseModelsPayload({ data: [{ id: "a" }] }, 1), {
    models: [{ id: "a", reasoning: false, thinkingCanDisable: false }],
    dropped: 0,
  });
});

test("skips non-object entries and keeps the first duplicate", () => {
  assert.deepEqual(
    parseModelsPayload({
      data: [
        null,
        "model",
        42,
        ["nested"],
        { id: "dup", context_length: 100 },
        { id: "dup", context_length: 200 },
        { id: "ok" },
      ],
    }),
    {
      models: [
        { id: "dup", reasoning: false, thinkingCanDisable: false, contextLimit: 100 },
        { id: "ok", reasoning: false, thinkingCanDisable: false },
      ],
      dropped: 0,
    },
  );
});

test("filters IDs with whitespace, control characters, or excessive length", () => {
  const valid512 = "x".repeat(512);
  const tabModel = `tab${String.fromCharCode(9)}here`;
  const delModel = `del${String.fromCharCode(127)}here`;
  assert.deepEqual(
    parseModelsPayload({
      data: [
        { id: valid512 },
        { id: "x".repeat(513) },
        { id: "trailing " },
        { id: " leading" },
        { id: "inner space allowed" },
        { id: tabModel },
        { id: delModel },
        { id: "trailing\n" },
      ],
    }),
    {
      models: [
        { id: valid512, reasoning: false, thinkingCanDisable: false },
        { id: "inner space allowed", reasoning: false, thinkingCanDisable: false },
      ],
      dropped: 0,
    },
  );
});

test("treats non-object or non-boolean capabilities as non-reasoning", () => {
  assert.deepEqual(parseModelsPayload({ data: [{ id: "a", capabilities: "yes" }] }), {
    models: [{ id: "a", reasoning: false, thinkingCanDisable: false }],
    dropped: 0,
  });
  assert.deepEqual(parseModelsPayload({ data: [{ id: "a", capabilities: null }] }), {
    models: [{ id: "a", reasoning: false, thinkingCanDisable: false }],
    dropped: 0,
  });
  assert.deepEqual(parseModelsPayload({ data: [{ id: "a", capabilities: [] }] }), {
    models: [{ id: "a", reasoning: false, thinkingCanDisable: false }],
    dropped: 0,
  });
  assert.deepEqual(
    parseModelsPayload({
      data: [{ id: "a", capabilities: { reasoning: "true", thinkingCanDisable: 1 } }],
    }),
    {
      models: [{ id: "a", reasoning: false, thinkingCanDisable: false }],
      dropped: 0,
    },
  );
});

test("prefers top-level token limits and falls back to capability fields", () => {
  assert.deepEqual(
    parseModelsPayload({
      data: [
        {
          id: "both",
          context_length: 100,
          max_completion_tokens: 50,
          capabilities: { contextWindow: 999, maxOutput: 888 },
        },
        {
          id: "fallback",
          context_length: 0,
          max_completion_tokens: -5,
          capabilities: { contextWindow: 500, maxOutput: 200 },
        },
        {
          id: "invalid",
          context_length: 2.5,
          max_completion_tokens: "100",
          capabilities: { contextWindow: Number.NaN, maxOutput: Number.MAX_SAFE_INTEGER + 1 },
        },
        { id: "none" },
      ],
    }),
    {
      models: [
        {
          id: "both",
          reasoning: false,
          thinkingCanDisable: false,
          contextLimit: 100,
          outputLimit: 50,
        },
        {
          id: "fallback",
          reasoning: false,
          thinkingCanDisable: false,
          contextLimit: 500,
          outputLimit: 200,
        },
        { id: "invalid", reasoning: false, thinkingCanDisable: false },
        { id: "none", reasoning: false, thinkingCanDisable: false },
      ],
      dropped: 0,
    },
  );
});

test("discovers models through a mock HTTP server with Bearer auth", async () => {
  const models = await discoverModels({ apiKey: "test-key", baseURL });
  assert.deepEqual(models, [
    {
      id: "ocg/muse-spark-1.3-contributor",
      reasoning: true,
      thinkingCanDisable: true,
      contextLimit: 1_000_000,
      outputLimit: 131_072,
    },
  ]);
});

test("sends the expected discovery request shape", async () => {
  let seen: { input: unknown; init: RequestInit | undefined } | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    seen = { input, init };
    return new Response('{"data":[]}', { status: 200 });
  };

  assert.deepEqual(await discoverModels({ apiKey: "test-key", baseURL }, { fetch: fetcher }), []);
  assert.equal(seen?.input, `${baseURL}/models`);
  const headers = new Headers(seen?.init?.headers);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer test-key");
  assert.equal(seen?.init?.redirect, "error");
  assert.ok(seen?.init?.signal instanceof AbortSignal);
});

test("returns an empty list when discovery finds no models", async () => {
  const fetcher: typeof fetch = async () => new Response('{"data":[]}', { status: 200 });
  assert.deepEqual(await discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher }), []);
});

test("rejects invalid JSON without leaking the body or key", async () => {
  const secret = "never-log-this-key";
  const fetcher: typeof fetch = async () =>
    new Response(`not json {{{ ${secret}`, { status: 200 });
  await assert.rejects(
    discoverModels({ apiKey: secret, baseURL }, { fetch: fetcher }),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.message, "9router returned invalid JSON from /models");
      assert.doesNotMatch(error.message, new RegExp(secret, "u"));
      return true;
    },
  );
});

test("rejects an empty body as invalid JSON", async () => {
  const fetcher: typeof fetch = async () => new Response("", { status: 200 });
  await assert.rejects(
    discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher }),
    /invalid JSON/u,
  );
});

test("handles a null response body as invalid JSON", async () => {
  const fetcher: typeof fetch = async () =>
    ({ ok: true, status: 200, headers: new Headers(), body: null }) as unknown as Response;
  await assert.rejects(
    discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher }),
    /invalid JSON/u,
  );
});

test("rejects an invalid payload shape from the server", async () => {
  const fetcher: typeof fetch = async () => new Response('{"models":[]}', { status: 200 });
  await assert.rejects(
    discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher }),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.match(error.message, /invalid \/models response/u);
      return true;
    },
  );
});

test("truncates via a custom maxModels option and reports the count", async () => {
  const fetcher: typeof fetch = async () =>
    new Response('{"data":[{"id":"a"},{"id":"b"}]}', { status: 200 });
  const seen: number[] = [];
  assert.deepEqual(
    await discoverModels(
      { apiKey: "k", baseURL },
      { fetch: fetcher, maxModels: 1, onTruncated: (dropped) => seen.push(dropped) },
    ),
    [{ id: "a", reasoning: false, thinkingCanDisable: false }],
  );
  assert.deepEqual(seen, [1]);

  const silent: number[] = [];
  await discoverModels(
    { apiKey: "k", baseURL },
    { fetch: fetcher, maxModels: 5, onTruncated: (dropped) => silent.push(dropped) },
  );
  assert.deepEqual(silent, []);
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

test("wraps fetch failures without leaking exception text", async () => {
  const secret = "never-log-this-key";
  const fetcher: typeof fetch = async () => {
    throw new TypeError(`boom containing ${secret}`);
  };
  await assert.rejects(
    discoverModels({ apiKey: secret, baseURL }, { fetch: fetcher, timeoutMs: 5_000 }),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.message, "9router model discovery failed");
      assert.doesNotMatch(error.message, new RegExp(secret, "u"));
      assert.doesNotMatch(error.message, /boom/u);
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

test("reports other HTTP statuses without the body", async () => {
  const fetcher: typeof fetch = async () => new Response("secret-body", { status: 500 });
  await assert.rejects(
    discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher }),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.message, "9router model discovery returned HTTP 500");
      assert.doesNotMatch(error.message, /secret-body/u);
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

test("rejects an oversized declared content-length before reading", async () => {
  const fetcher: typeof fetch = async () =>
    new Response("x".repeat(100), {
      status: 200,
      headers: { "content-length": "100" },
    });
  await assert.rejects(
    discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher, maxBytes: 5 }),
    /too large/u,
  );
});

test("accepts a declared content-length at exactly the limit", async () => {
  const body = '{"data":[]}';
  const fetcher: typeof fetch = async () =>
    new Response(body, {
      status: 200,
      headers: { "content-length": String(new TextEncoder().encode(body).byteLength) },
    });
  assert.deepEqual(
    await discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher, maxBytes: 1_048_576 }),
    [],
  );
});

test("tolerates a non-numeric declared content-length", async () => {
  const fetcher: typeof fetch = async () =>
    new Response('{"data":[]}', { status: 200, headers: { "content-length": "unknown" } });
  assert.deepEqual(await discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher }), []);
});

test("cancels an oversized stream and a failing stream", async () => {
  for (const maxBytes of [5, 1_048_576]) {
    let cancelled = false;
    let released = false;
    const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
    let index = 0;
    const fetcher: typeof fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          getReader: () => ({
            read: async () => {
              if (maxBytes < 1_048_576) {
                return index < parts.length
                  ? { done: false, value: parts[index++] as Uint8Array }
                  : { done: true, value: undefined };
              }
              // 0xFF is invalid UTF-8 and trips the fatal decoder.
              return { done: false, value: new Uint8Array([0xff]) };
            },
            cancel: async () => {
              cancelled = true;
            },
            releaseLock: () => {
              released = true;
            },
          }),
        },
      }) as unknown as Response;
    await assert.rejects(
      discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher, maxBytes }),
      maxBytes < 1_048_576 ? /too large/u : /Unable to read/u,
    );
    assert.equal(cancelled, true);
    assert.equal(released, true);
  }
});

test("wraps body read failures without leaking details", async () => {
  const fetcher: typeof fetch = async () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            throw new Error("boom with secret-body");
          },
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
    }) as unknown as Response;
  await assert.rejects(
    discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher }),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.message, "Unable to read the 9router /models response");
      assert.doesNotMatch(error.message, /boom|secret-body/u);
      return true;
    },
  );
});

test("rejects invalid maxModels inside parseModelsPayload", () => {
  for (const maxModels of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => parseModelsPayload({ data: [{ id: "a" }] }, maxModels),
      (error: unknown) => {
        assert.ok(error instanceof DiscoveryError);
        assert.match((error as Error).message, /invalid \/models response/u);
        return true;
      },
    );
  }
});

test("ignores a throwing onTruncated callback", async () => {
  const fetcher: typeof fetch = async () =>
    new Response('{"data":[{"id":"a"},{"id":"b"}]}', { status: 200 });
  assert.deepEqual(
    await discoverModels(
      { apiKey: "k", baseURL },
      {
        fetch: fetcher,
        maxModels: 1,
        onTruncated: () => {
          throw new Error("observer blew up");
        },
      },
    ),
    [{ id: "a", reasoning: false, thinkingCanDisable: false }],
  );
});

test("reports a TimeoutError rejection as a timeout without a live signal", async () => {
  const timeoutError = new DOMException("operation timed out", "TimeoutError");
  const fetcher: typeof fetch = async () => {
    throw timeoutError;
  };
  await assert.rejects(
    discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher, timeoutMs: 60_000 }),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.match(error.message, /timed out/u);
      return true;
    },
  );
});

test("reports a non-Error rejection without leaking details", async () => {
  const fetcher: typeof fetch = async () => {
    throw undefined;
  };
  await assert.rejects(
    discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher }),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.message, "9router model discovery failed");
      return true;
    },
  );
});

test("wraps an invalid timeout option instead of throwing RangeError", async () => {
  const fetcher: typeof fetch = async () => new Response('{"data":[]}', { status: 200 });
  for (const timeoutMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher, timeoutMs }),
      (error: unknown) => {
        assert.ok(error instanceof DiscoveryError);
        assert.equal(error.message, "9router model discovery failed");
        assert.ok(!(error instanceof RangeError));
        return true;
      },
    );
  }
});

test("rejects invalid size caps instead of accumulating without bound", async () => {
  const fetcher: typeof fetch = async () => new Response('{"data":[]}', { status: 200 });
  for (const options of [
    { maxBytes: Number.NaN },
    { maxBytes: 0 },
    { maxBytes: -5 },
    { maxModels: Number.NaN },
    { maxModels: 0 },
    { maxModels: -2 },
  ]) {
    await assert.rejects(
      discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher, ...options }),
      (error: unknown) => {
        assert.ok(error instanceof DiscoveryError);
        assert.equal(error.message, "9router model discovery failed");
        return true;
      },
    );
  }
});

test("tolerates a reader whose releaseLock throws on the success path", async () => {
  const payload = '{"data":[{"id":"a"}]}';
  const bytes = new TextEncoder().encode(payload);
  const fetcher: typeof fetch = async () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => {
          let consumed = false;
          return {
            read: async () => {
              if (consumed) return { done: true, value: undefined };
              consumed = true;
              return { done: false, value: bytes };
            },
            cancel: async () => undefined,
            releaseLock: () => {
              throw new Error("already released");
            },
          };
        },
      },
    }) as unknown as Response;
  assert.deepEqual(await discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher }), [
    { id: "a", reasoning: false, thinkingCanDisable: false },
  ]);
});

test("tolerates a reader whose cancel rejects", async () => {
  const fetcher: typeof fetch = async () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            throw new Error("boom with secret-body");
          },
          cancel: async () => {
            throw new Error("cancel blew up");
          },
          releaseLock: () => undefined,
        }),
      },
    }) as unknown as Response;
  await assert.rejects(
    discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher }),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.message, "Unable to read the 9router /models response");
      assert.doesNotMatch(error.message, /boom|secret-body|cancel blew up/u);
      return true;
    },
  );
});

test("tolerates a reader whose releaseLock throws after cancel", async () => {
  const fetcher: typeof fetch = async () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            throw new Error("boom with secret-body");
          },
          cancel: async () => undefined,
          releaseLock: () => {
            throw new Error("already released");
          },
        }),
      },
    }) as unknown as Response;
  await assert.rejects(
    discoverModels({ apiKey: "k", baseURL }, { fetch: fetcher }),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryError);
      assert.equal(error.message, "Unable to read the 9router /models response");
      assert.doesNotMatch(error.message, /boom|secret-body|already released/u);
      return true;
    },
  );
});

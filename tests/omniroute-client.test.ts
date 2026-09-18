import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchOmniRouteAutoCombos,
  fetchOmniRouteCombos,
  fetchOmniRouteEnrichment,
  fetchOmniRouteModels,
  fetchOmniRouteProviders,
  getJSON,
  managementURL,
  modelsURL,
  OmniRouteClientError,
} from "../src/omniroute/client.js";

const json = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

const stubFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  }) as typeof fetch;

test("resolves inference and management URLs from either base form", () => {
  assert.equal(modelsURL("http://gw:20128"), "http://gw:20128/v1/models");
  assert.equal(modelsURL("http://gw:20128/v1"), "http://gw:20128/v1/models");
  assert.equal(modelsURL("http://gw:20128/v1/"), "http://gw:20128/v1/models");
  assert.equal(managementURL("http://gw:20128/v1", "/api/combos"), "http://gw:20128/api/combos");
  assert.equal(managementURL("http://gw:20128", "/api/combos"), "http://gw:20128/api/combos");
});

test("sends bearer auth without redirects and parses the standard envelope", async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const fetch = stubFetch((url, init) => {
    seen = { url, init };
    return json({ data: [{ id: "cc/a" }, { id: 42 }, null] });
  });
  const models = await fetchOmniRouteModels("http://gw:20128", "secret", { fetch });
  assert.deepEqual(models, [{ id: "cc/a" }]);
  assert.equal(seen?.url, "http://gw:20128/v1/models");
  const headers = new Headers(seen?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer secret");
  assert.equal(seen?.init?.redirect, "error");
});

test("accepts a bare array models payload", async () => {
  const fetch = stubFetch(() => json([{ id: "cc/a" }]));
  assert.deepEqual(await fetchOmniRouteModels("http://gw:20128/v1", "k", { fetch }), [
    { id: "cc/a" },
  ]);
});

test("reports HTTP, JSON and timeout failures without secrets", async () => {
  const secret = "never-log-this-key";
  await assert.rejects(
    fetchOmniRouteModels("http://gw", secret, {
      fetch: stubFetch(() => json("secret-body", 500)),
    }),
    (error: unknown) => {
      assert.ok(error instanceof OmniRouteClientError);
      assert.equal((error as Error).message, "omniroute request returned HTTP 500");
      assert.doesNotMatch((error as Error).message, /secret/u);
      return true;
    },
  );
  await assert.rejects(
    getJSON("http://gw/v1/models", secret, {
      fetch: stubFetch(() => json("not json {{{", 200)),
    }),
    /invalid JSON/u,
  );
  await assert.rejects(
    getJSON("http://gw/v1/models", secret, {
      fetch: stubFetch(() => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    }),
    /timed out/u,
  );
  await assert.rejects(
    getJSON("http://gw/v1/models", "", {}),
    /requires an API key/u,
  );
});

test("fetches combos from the management plane with both envelopes", async () => {
  const seen: string[] = [];
  const fetch = stubFetch((url) => {
    seen.push(url);
    return json({ combos: [{ id: "mix" }], total: 1 });
  });
  assert.deepEqual(await fetchOmniRouteCombos("http://gw:20128/v1", "k", { fetch }), [
    { id: "mix" },
  ]);
  assert.deepEqual(seen, ["http://gw:20128/api/combos"]);

  const bare = stubFetch(() => json([{ id: "mix" }]));
  assert.deepEqual(await fetchOmniRouteCombos("http://gw:20128", "k", { fetch: bare }), [
    { id: "mix" },
  ]);
});

test("reports combo failures to the source observer", async () => {
  const reported: Array<[string, string]> = [];
  await assert.rejects(
    fetchOmniRouteCombos("http://gw", "k", {
      fetch: stubFetch(() => json("no", 403)),
      onSourceError: (endpoint, reason) => reported.push([endpoint, reason]),
    }),
    /HTTP 403/u,
  );
  assert.deepEqual(reported, [["/api/combos", "omniroute request returned HTTP 403"]]);
});

test("treats auto-combos 404 as empty but throws on other refusals", async () => {
  const gone = stubFetch(() => json("missing", 404));
  assert.deepEqual(await fetchOmniRouteAutoCombos("http://gw", "k", { fetch: gone }), []);

  const reported: string[] = [];
  await assert.rejects(
    fetchOmniRouteAutoCombos("http://gw", "k", {
      fetch: stubFetch(() => json("denied", 403)),
      onSourceError: (endpoint, reason) => reported.push(`${endpoint}:${reason}`),
    }),
    /HTTP 403/u,
  );
  assert.equal(reported.length, 1);

  // No key means nothing to ask with.
  assert.deepEqual(
    await fetchOmniRouteAutoCombos("http://gw", "", {
      fetch: stubFetch(() => {
        throw new Error("must not fetch");
      }),
    }),
    [],
  );
});

test("parses provider connections from every envelope and skips invalid rows", async () => {
  const payload = {
    connections: [
      { id: "1", provider: "claude", isActive: true, testStatus: "active" },
      { provider: "kiro" },
      { id: "x" },
      null,
    ],
  };
  const fetch = stubFetch(() => json(payload));
  assert.deepEqual(await fetchOmniRouteProviders("http://gw", "k", { fetch }), [
    { id: "1", provider: "claude", isActive: true, testStatus: "active" },
    { provider: "kiro", id: "kiro" },
  ]);

  const bare = stubFetch(() => json([{ id: "1", provider: "a" }]));
  assert.deepEqual(await fetchOmniRouteProviders("http://gw", "k", { fetch: bare }), [
    { id: "1", provider: "a" },
  ]);
  const data = stubFetch(() => json({ data: [{ id: "1", provider: "a" }] }));
  assert.deepEqual(await fetchOmniRouteProviders("http://gw", "k", { fetch: data }), [
    { id: "1", provider: "a" },
  ]);
});

test("strips credential material from provider connections", async () => {
  const fetch = stubFetch(() =>
    json([
      {
        id: "1",
        provider: "claude",
        isActive: true,
        testStatus: "active",
        apiKey: "secret-key",
        credentials: { token: "secret-token" },
      },
    ]),
  );
  const connections = await fetchOmniRouteProviders("http://gw", "k", { fetch });
  assert.deepEqual(connections, [
    { id: "1", provider: "claude", isActive: true, testStatus: "active" },
  ]);
  assert.doesNotMatch(JSON.stringify(connections), /secret/u);
});

test("enriches names, pricing and free budgets from all three sources", async () => {
  const fetch = stubFetch((url) => {
    if (url.endsWith("/api/pricing/models")) {
      return json({
        cc: {
          id: "claude",
          alias: "cc",
          name: "Claude",
          models: [{ id: "claude-opus", name: "Claude Opus" }],
        },
      });
    }
    if (url.endsWith("/api/pricing")) {
      return json({ cc: { "claude-opus": { input: 15, output: 75, cached: 1.5, cache_creation: 18 } } });
    }
    return json({
      perModel: [
        {
          provider: "cc",
          modelId: "claude-opus",
          freeType: "recurring-monthly",
          monthlyTokens: 1_000_000,
        },
      ],
    });
  });
  const map = await fetchOmniRouteEnrichment("http://gw", "k", { fetch });
  const namespaced = map.get("cc/claude-opus");
  assert.equal(namespaced?.name, "Claude Opus");
  assert.equal(namespaced?.providerAlias, "cc");
  assert.equal(namespaced?.providerCanonical, "claude");
  assert.equal(namespaced?.providerDisplayName, "Claude");
  assert.deepEqual(namespaced?.pricing, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18 });
  assert.equal(namespaced?.freeType, "recurring-monthly");
  assert.equal(namespaced?.monthlyTokens, 1_000_000);
  // Bare fallback key exists with its own copy.
  assert.equal(map.get("claude-opus")?.name, "Claude Opus");
  assert.notEqual(map.get("claude-opus"), namespaced);
});

test("keeps partial enrichment when one source fails and throws when all fail", async () => {
  const partial = stubFetch((url) => {
    if (url.endsWith("/api/pricing/models")) return json("bad", 500);
    if (url.endsWith("/api/pricing")) return json({ cc: { m: { input: 1, output: 2 } } });
    return json("bad", 500);
  });
  const reported: string[] = [];
  const map = await fetchOmniRouteEnrichment("http://gw", "k", {
    fetch: partial,
    onSourceError: (endpoint) => reported.push(endpoint),
  });
  assert.equal(map.get("cc/m")?.pricing?.input, 1);
  assert.ok(reported.includes("/api/pricing/models"));

  const total = stubFetch(() => json("bad", 500));
  await assert.rejects(
    fetchOmniRouteEnrichment("http://gw", "k", { fetch: total }),
    /enrichment sources failed/u,
  );
});

test("never writes one provider price onto another provider bare entry", async () => {
  const fetch = stubFetch((url) => {
    if (url.endsWith("/api/pricing/models")) {
      return json({
        cc: { id: "claude", name: "Claude", models: [{ id: "shared" }] },
        kr: { id: "kiro", name: "Kiro", models: [{ id: "shared" }] },
      });
    }
    if (url.endsWith("/api/pricing")) {
      return json({ cc: { shared: { input: 1, output: 1 } }, kr: { shared: { input: 9, output: 9 } } });
    }
    return json({ perModel: [] });
  });
  const map = await fetchOmniRouteEnrichment("http://gw", "k", { fetch });
  assert.equal(map.get("cc/shared")?.pricing?.input, 1);
  assert.equal(map.get("kr/shared")?.pricing?.input, 9);
  assert.equal(map.get("shared")?.pricing?.input, 1);
});

test("wraps network failures and honours explicit timeouts", async () => {
  await assert.rejects(
    fetchOmniRouteModels("http://gw", "k", {
      fetch: stubFetch(() => {
        throw new TypeError("boom");
      }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof OmniRouteClientError);
      assert.equal((error as Error).message, "omniroute request failed");
      return true;
    },
  );
  // Explicit timeout budgets are accepted.
  const fetch = stubFetch(() => json({ data: [] }));
  assert.deepEqual(
    await fetchOmniRouteModels("http://gw", "k", { fetch, timeoutMs: 50 }),
    [],
  );
  assert.deepEqual(await fetchOmniRouteModels("http://gw", "k", { fetch, timeoutMs: NaN }), []);
  await assert.rejects(
    fetchOmniRouteCombos("http://gw", "k", {
      fetch: stubFetch(() => {
        throw new TypeError("down");
      }),
    }),
    /omniroute request failed/u,
  );
});

test("reports auto-combo transport failures and accepts data envelopes", async () => {
  const reported: string[] = [];
  await assert.rejects(
    fetchOmniRouteAutoCombos("http://gw", "k", {
      fetch: stubFetch(() => {
        throw new DOMException("slow", "TimeoutError");
      }),
      onSourceError: (endpoint, reason) => reported.push(`${endpoint}:${reason}`),
    }),
    /timed out/u,
  );
  assert.deepEqual(reported, ["/api/combos/auto:omniroute request timed out"]);

  const data = stubFetch(() => json({ data: [{ id: "auto" }] }));
  assert.deepEqual(await fetchOmniRouteAutoCombos("http://gw", "k", { fetch: data }), []);
  const combos = stubFetch(() => json({ combos: [{ id: "auto" }] }));
  assert.deepEqual(await fetchOmniRouteAutoCombos("http://gw", "k", { fetch: combos }), [
    { id: "auto" },
  ]);
  const bad = stubFetch(() => json({ combos: [{ id: 1 }] }));
  assert.deepEqual(await fetchOmniRouteAutoCombos("http://gw", "k", { fetch: bad }), []);
});

test("reports provider failures without leaking details", async () => {
  const reported: Array<[string, string]> = [];
  await assert.rejects(
    fetchOmniRouteProviders("http://gw", "k", {
      fetch: stubFetch(() => {
        throw new TypeError("down");
      }),
      onSourceError: (endpoint, reason) => reported.push([endpoint, reason]),
    }),
    /omniroute request failed/u,
  );
  assert.deepEqual(reported, [["/api/providers", "omniroute request failed"]]);
});

test("releases response bodies even when cancellation itself fails", async () => {
  const failing = {
    ok: false,
    status: 503,
    headers: new Headers(),
    body: {
      cancel: async () => {
        throw new Error("cancel blew up");
      },
    },
  } as unknown as Response;
  await assert.rejects(
    fetchOmniRouteModels("http://gw", "k", { fetch: async () => failing }),
    /HTTP 503/u,
  );
  const gone = {
    status: 404,
    headers: new Headers(),
    body: {
      cancel: async () => {
        throw new Error("cancel blew up");
      },
    },
  } as unknown as Response;
  assert.deepEqual(
    await fetchOmniRouteAutoCombos("http://gw", "k", { fetch: async () => gone }),
    [],
  );
});

test("parses alternate pricing keys and skips invalid slots", async () => {
  const fetch = stubFetch((url) => {
    if (url.endsWith("/api/pricing/models")) {
      return json({
        cc: {
          id: "claude",
          name: "Claude",
          models: [{ id: "a" }, { id: "b" }, { name: "no-id" }, null],
        },
        broken: "not-a-slot",
      });
    }
    if (url.endsWith("/api/pricing")) {
      return json({
        cc: {
          a: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.6 },
          b: { input: "free", output: null },
          c: {},
          d: "nope",
        },
      });
    }
    return json([]);
  });
  const map = await fetchOmniRouteEnrichment("http://gw", "k", { fetch });
  assert.deepEqual(map.get("cc/a")?.pricing, { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.6 });
  assert.equal(map.get("cc/b")?.pricing, undefined);
  assert.equal(map.has("cc/c"), false);
});

test("returns an empty overlay without credentials and reads bare free-tier lists", async () => {
  let calls = 0;
  const map = await fetchOmniRouteEnrichment("", "", {
    fetch: stubFetch(() => {
      calls += 1;
      return json({});
    }),
  });
  assert.equal(map.size, 0);
  assert.equal(calls, 0);

  const fetch = stubFetch((url) => {
    if (url.endsWith("/api/pricing/models")) return json({ cc: { id: "c", models: [{ id: "m" }] } });
    if (url.endsWith("/api/pricing")) return json({});
    return json([
      { provider: "cc", modelId: "m", freeType: "keyless" },
      { provider: "cc", modelId: "m", freeType: "recurring-credit", creditTokens: 5000 },
      null,
      { provider: "cc" },
      { provider: "cc", modelId: "m", freeType: "", },
    ]);
  });
  const enriched = await fetchOmniRouteEnrichment("http://gw", "k", { fetch });
  assert.equal(enriched.get("cc/m")?.freeType, "recurring-credit");
  assert.equal(enriched.get("cc/m")?.creditTokens, 5000);
});

test("cleans up failing auto-combo bodies and reports invalid payloads", async () => {
  const reported: Array<[string, string]> = [];
  const failing = {
    ok: false,
    status: 403,
    headers: new Headers(),
    body: {
      cancel: async () => {
        throw new Error("cancel blew up");
      },
    },
  } as unknown as Response;
  await assert.rejects(
    fetchOmniRouteAutoCombos("http://gw", "k", {
      fetch: async () => failing,
      onSourceError: (endpoint, reason) => reported.push([endpoint, reason]),
    }),
    /HTTP 403/u,
  );
  assert.deepEqual(reported, [["/api/combos/auto", "omniroute request returned HTTP 403"]]);

  const invalid = {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => {
      throw new SyntaxError("bad json");
    },
  } as unknown as Response;
  await assert.rejects(
    fetchOmniRouteAutoCombos("http://gw", "k", {
      fetch: async () => invalid,
      onSourceError: (endpoint, reason) => reported.push([endpoint, reason]),
    }),
    /invalid JSON/u,
  );
  assert.deepEqual(reported[1], ["/api/combos/auto", "omniroute returned invalid JSON"]);
});

test("tolerates throwing source observers during enrichment", async () => {
  const fetch = stubFetch((url) => {
    if (url.endsWith("/api/pricing/models")) return json({ cc: { id: "c", models: [{ id: "m" }] } });
    return json("bad", 500);
  });
  const map = await fetchOmniRouteEnrichment("http://gw", "k", {
    fetch,
    onSourceError: () => {
      throw new Error("observer blew up");
    },
  });
  assert.equal(map.get("cc/m")?.providerAlias, "cc");
});

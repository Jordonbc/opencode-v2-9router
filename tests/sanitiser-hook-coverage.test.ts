import assert from "node:assert/strict";
import test from "node:test";
import { createOmniRouteCache } from "../src/omniroute/cache.js";
import { setupOmniRoute } from "../src/omniroute/setup.js";

const baseConfig = (responseSanitization: boolean) => ({
  providerID: "omniroute",
  displayName: "OmniRoute",
  gatewayRoot: "http://gw:20128",
  baseURL: "http://gw:20128/v1",
  apiKey: "test-key",
  managementKey: undefined,
  timeoutMs: 10_000,
  timeouts: { models: 10_000, combos: 10_000, autoCombos: 5_000, enrichment: 10_000 },
  cacheTtlMs: 300_000,
  usableOnly: false,
  enrichment: true,
  providerTag: true,
  geminiSanitization: false,
  responseSanitization,
  visibleModels: [],
  hiddenModels: [],
  allowAnthropic: false,
  anthropicModels: [],
  anthropicPrefixes: [],
  logLevel: "warn" as const,
});

const deps = () => ({
  config: async () => ({ ok: true as const, value: baseConfig(true) }),
  fetchers: {
    models: async () => [{ id: "cc/a" }],
    combos: async () => [],
    autoCombos: async () => [],
    providers: async () => [],
    enrichment: async () => new Map(),
  },
  createCache: (ttlMs: number) => createOmniRouteCache({ ttlMs }),
  readSnapshot: async () => undefined,
  writeSnapshot: async () => true,
  snapshotFile: () => "/tmp/omniroute-test.json",
  connectionKey: async () => undefined,
  warn: () => undefined,
  info: () => undefined,
});

test("unavailable when no session", async () => {
  const warnings: string[] = [];
  const context: any = {
    provider: { transform: async (u: any) => { u({ list: () => [], get: () => undefined, add: () => undefined, update: () => undefined, remove: () => undefined, models: { set: () => undefined, update: () => undefined, remove: () => undefined } }); return { dispose: async () => undefined }; }, reload: async () => undefined },
    integration: undefined,
    aisdk: undefined,
  };
  await setupOmniRoute(context, { ...deps(), warn: (m: string) => warnings.push(m) });
  assert.ok(warnings.some((w) => w.includes("response sanitization unavailable")));
});

test("unavailable when session has no hook", async () => {
  const warnings: string[] = [];
  const context: any = {
    provider: { transform: async (u: any) => { u({ list: () => [], get: () => undefined, add: () => undefined, update: () => undefined, remove: () => undefined, models: { set: () => undefined, update: () => undefined, remove: () => undefined } }); return { dispose: async () => undefined }; }, reload: async () => undefined },
    integration: undefined,
    aisdk: undefined,
    session: {},
  };
  await setupOmniRoute(context, { ...deps(), warn: (m: string) => warnings.push(m) });
  assert.ok(warnings.some((w) => w.includes("response sanitization unavailable")));
});

test("unavailable when hook throws", async () => {
  const warnings: string[] = [];
  const context: any = {
    provider: { transform: async (u: any) => { u({ list: () => [], get: () => undefined, add: () => undefined, update: () => undefined, remove: () => undefined, models: { set: () => undefined, update: () => undefined, remove: () => undefined } }); return { dispose: async () => undefined }; }, reload: async () => undefined },
    integration: undefined,
    aisdk: undefined,
    session: { hook: async () => { throw new Error("boom"); } },
  };
  await setupOmniRoute(context, { ...deps(), warn: (m: string) => warnings.push(m) });
  assert.ok(warnings.some((w) => w.includes("response sanitization unavailable")));
});

test("callback early returns for non-object inputs", async () => {
  let cb: any;
  const context: any = {
    provider: { transform: async (u: any) => { u({ list: () => [], get: () => undefined, add: () => undefined, update: () => undefined, remove: () => undefined, models: { set: () => undefined, update: () => undefined, remove: () => undefined } }); return { dispose: async () => undefined }; }, reload: async () => undefined },
    integration: undefined,
    aisdk: undefined,
    session: { hook: async (_n: string, c: any) => { cb = c; return { dispose: async () => undefined }; } },
  };
  await setupOmniRoute(context, deps());
  // non-object input
  await cb(null);
  await cb({});
  // provider mismatch
  await cb({ model: { providerID: "other", id: "opencode-go/beam-free" }, response: new Response("x", { headers: { "content-type": "text/event-stream" } }) });
  // non-string id
  await cb({ model: { providerID: "omniroute", id: 5 }, response: new Response("x", { headers: { "content-type": "text/event-stream" } }) });
  // non-affected route
  await cb({ model: { providerID: "omniroute", id: "openai/gpt-4" }, response: new Response("x", { headers: { "content-type": "text/event-stream" } }) });
  // non-Response
  await cb({ model: { providerID: "omniroute", id: "opencode-go/beam-free" }, response: "x" });
  // non-SSE
  await cb({ model: { providerID: "omniroute", id: "opencode-go/beam-free" }, response: new Response("x", { headers: { "content-type": "text/plain" } }) });
  // no body
  await cb({ model: { providerID: "omniroute", id: "opencode-go/beam-free" }, response: new Response(null, { headers: { "content-type": "text/event-stream" } }) });
  assert.ok(true);
});

test("callback transforms SSE body", async () => {
  let cb: any;
  const context: any = {
    provider: { transform: async (u: any) => { u({ list: () => [], get: () => undefined, add: () => undefined, update: () => undefined, remove: () => undefined, models: { set: () => undefined, update: () => undefined, remove: () => undefined } }); return { dispose: async () => undefined }; }, reload: async () => undefined },
    integration: undefined,
    aisdk: undefined,
    session: { hook: async (_n: string, c: any) => { cb = c; return { dispose: async () => undefined }; } },
  };
  await setupOmniRoute(context, deps());
  const res = new Response("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"opencode\":{\"billing_source\":\"go-plus\"}}}\n\n", { status: 200, statusText: "OK", headers: { "content-type": "text/event-stream" } });
  const ev: any = { model: { providerID: "omniroute", id: "opencode-go/beam-free" }, response: res };
  await cb(ev);
  const text = await ev.response.text();
  assert.match(text, /prompt_tokens/);
  assert.doesNotMatch(text, /opencode/);
});

test("callback transform handles errors gracefully", async () => {
  let cb: any;
  const context: any = {
    provider: { transform: async (u: any) => { u({ list: () => [], get: () => undefined, add: () => undefined, update: () => undefined, remove: () => undefined, models: { set: () => undefined, update: () => undefined, remove: () => undefined } }); return { dispose: async () => undefined }; }, reload: async () => undefined },
    integration: undefined,
    aisdk: undefined,
    session: { hook: async (_n: string, c: any) => { cb = c; return { dispose: async () => undefined }; } },
  };
  await setupOmniRoute(context, deps());
  // Force response.body to throw during read by using a body that errors
  const stream = new ReadableStream({
    start(controller) {
      controller.error(new Error("boom"));
    },
  });
  const res = new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  const ev: any = { model: { providerID: "omniroute", id: "opencode-go/beam-free" }, response: res };
  await cb(ev);
  // reading should reject
  await assert.rejects(() => ev.response.text());
});
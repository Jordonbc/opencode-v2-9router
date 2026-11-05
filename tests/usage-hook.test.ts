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

test("usage sanitization registers language hook when enabled", async () => {
  let hookCalls = 0;
  const context: any = {
    provider: { transform: async (u: any) => { u({ list: () => [], get: () => undefined, add: () => undefined, update: () => undefined, remove: () => undefined, models: { set: () => undefined, update: () => undefined, remove: () => undefined } }); return { dispose: async () => undefined }; }, reload: async () => undefined },
    integration: undefined,
    aisdk: { hook: async () => { hookCalls += 1; return { dispose: async () => undefined }; } },
    session: { hook: async () => ({ dispose: async () => undefined }) },
  };
  await setupOmniRoute(context, deps());
  assert.equal(hookCalls, 1);
});

test("usage sanitization no-op when disabled", async () => {
  let hookCalls = 0;
  const context: any = {
    provider: { transform: async (u: any) => { u({ list: () => [], get: () => undefined, add: () => undefined, update: () => undefined, remove: () => undefined, models: { set: () => undefined, update: () => undefined, remove: () => undefined } }); return { dispose: async () => undefined }; }, reload: async () => undefined },
    integration: undefined,
    aisdk: { hook: async () => { hookCalls += 1; return { dispose: async () => undefined }; } },
    session: { hook: async () => ({ dispose: async () => undefined }) },
  };
  await setupOmniRoute(context, { ...deps(), config: async () => ({ ok: true as const, value: baseConfig(false) }) });
  assert.equal(hookCalls, 0);
});
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

const makeContext = () => {
  const editor = {
    list: () => [],
    get: () => undefined,
    add: () => undefined,
    update: () => undefined,
    remove: () => undefined,
    models: { set: () => undefined, update: () => undefined, remove: () => undefined },
  };
  let hookCalls = 0;
  const context: any = {
    provider: {
      transform: async (u: any) => {
        u(editor);
        return { dispose: async () => undefined };
      },
      reload: async () => undefined,
    },
    integration: undefined,
    aisdk: undefined,
    session: {
      hook: async () => {
        hookCalls += 1;
        return { dispose: async () => undefined };
      },
    },
  };
  return { context, getHookCalls: () => hookCalls };
};

test("response sanitiser is disabled by default", async () => {
  const { context, getHookCalls } = makeContext();
  await setupOmniRoute(context, {
    config: async () => ({ ok: true as const, value: baseConfig(false) }),
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
  assert.equal(getHookCalls(), 0);
});

test("response sanitiser registers only when enabled", async () => {
  const { context, getHookCalls } = makeContext();
  await setupOmniRoute(context, {
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
  assert.equal(getHookCalls(), 1);
});
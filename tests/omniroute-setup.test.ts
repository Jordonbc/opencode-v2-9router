import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError } from "../src/config.js";
import type { ProviderEditor } from "../src/provider.js";
import { createOmniRouteCache } from "../src/omniroute/cache.js";
import {
  defaultOmniRouteDeps,
  setupOmniRoute,
  type OmniRouteContext,
  type OmniRouteFetchers,
  type PartialOmniRouteSetupDeps,
} from "../src/omniroute/setup.js";
import { createPlugin } from "../src/index.js";

type MutableRecord = Record<string, unknown>;

const baseConfig = {
  providerID: "omniroute",
  displayName: "OmniRoute",
  gatewayRoot: "http://gw:20128",
  baseURL: "http://gw:20128/v1",
  apiKey: "test-key",
  managementKey: undefined as string | undefined,
  timeoutMs: 10_000,
  timeouts: { models: 10_000, combos: 10_000, autoCombos: 5_000, enrichment: 10_000 },
  cacheTtlMs: 300_000,
  usableOnly: false,
  enrichment: true,
  providerTag: true,
  geminiSanitization: true,
  visibleModels: [],
  hiddenModels: [],
  allowAnthropic: false,
  anthropicModels: [],
  anthropicPrefixes: [],
  logLevel: "warn" as const,
};

const createEditor = (): {
  readonly editor: ProviderEditor;
  readonly providers: Map<string, MutableRecord>;
  readonly models: Map<string, MutableRecord>;
} => {
  const providers = new Map<string, MutableRecord>();
  const models = new Map<string, MutableRecord>();
  const editor = {
    list: () => [],
    get: (id: string) => providers.get(id) as never,
    add: ({ info, models: initial }: { info: MutableRecord; models: readonly MutableRecord[] }) => {
      providers.set(info.id as string, { ...info });
      for (const model of initial) models.set(model.id as string, model);
    },
    update: (id: string, apply: (provider: MutableRecord) => void) => {
      const provider = providers.get(id) ?? { id, settings: {} };
      providers.set(id, provider);
      apply(provider);
    },
    remove: () => undefined,
    models: {
      set: (providerID: string, infos: readonly MutableRecord[]) => {
        for (const model of infos) models.set(`${providerID}/${model.id as string}`, model);
      },
      update: () => undefined,
      remove: () => undefined,
    },
  } as unknown as ProviderEditor;
  return { editor, providers, models };
};

type TestContext = OmniRouteContext & {
  readonly transforms: () => number;
  readonly reloads: () => number;
};

const createContext = (stores?: ReturnType<typeof createEditor>): TestContext & {
  readonly providers: Map<string, MutableRecord>;
  readonly models: Map<string, MutableRecord>;
} => {
  const { editor, providers, models } = stores ?? createEditor();
  let transforms = 0;
  let reloads = 0;
  return {
    providers,
    models,
    transforms: () => transforms,
    reloads: () => reloads,
    provider: {
      transform: (async (update: (editor: ProviderEditor) => void) => {
        transforms += 1;
        update(editor);
        return { dispose: async () => undefined };
      }) as TestContext["provider"]["transform"],
      reload: async () => {
        reloads += 1;
      },
    },
    integration: undefined,
    aisdk: undefined,
  };
};

const deps = (overrides: PartialOmniRouteSetupDeps = {}): PartialOmniRouteSetupDeps => ({
  config: async () => ({ ok: true, value: { ...baseConfig } }),
  fetchers: {
    models: async () => [{ id: "cc/a" }],
    combos: async () => [],
    autoCombos: async () => [],
    providers: async () => [],
    enrichment: async () => new Map(),
  },
  createCache: (ttlMs) => createOmniRouteCache({ ttlMs }),
  readSnapshot: async () => undefined,
  writeSnapshot: async () => true,
  snapshotFile: () => join(tmpdir(), `omniroute-unit-test-${process.pid}.json`),
  connectionKey: async () => undefined,
  warn: () => undefined,
  info: () => undefined,
  ...overrides,
});

test("stays silent when OmniRoute is not configured", async () => {
  const warnings: string[] = [];
  const context = createContext();
  await setupOmniRoute(context, deps({ config: async () => ({ ok: true, value: undefined }), warn: (message) => warnings.push(message) }));
  assert.deepEqual(warnings, []);
  assert.equal(context.transforms(), 0);
});

test("warns on invalid configuration without throwing", async () => {
  const warnings: string[] = [];
  const context = createContext();
  await setupOmniRoute(
    context,
    deps({
      config: async () => {
        throw new Error("boom");
      },
      warn: (message) => warnings.push(message),
    }),
  );
  assert.deepEqual(warnings, ["opencode-9router-v2: invalid omniroute configuration"]);
  assert.equal(context.transforms(), 0);
});

test("registers live models through the configured gateway", async () => {
  const warnings: string[] = [];
  const infos: string[] = [];
  const context = createContext();
  await setupOmniRoute(
    context,
    deps({
      fetchers: {
        models: async () => [{ id: "cc/a", context_length: 5000 }],
        combos: async () => [{ id: "mix", models: [{ kind: "model", model: "cc/a" }] }],
        autoCombos: async () => [{ id: "auto", candidateCount: 3 }],
        providers: async () => [],
        enrichment: async () =>
          new Map([["cc/a", { name: "Claude A", providerAlias: "cc", providerDisplayName: "Claude" }]]),
      },
      warn: (message) => warnings.push(message),
      info: (message) => infos.push(message),
    }),
  );
  assert.deepEqual(warnings, []);
  assert.equal(context.transforms(), 1);
  assert.ok(infos.some((message) => message.includes("from OmniRoute")));
  assert.ok(context.providers.get("omniroute"));
  assert.equal(
    (context.providers.get("omniroute")?.settings as Record<string, unknown>).baseURL,
    "http://gw:20128/v1",
  );
  const keys = [...context.models.keys()];
  assert.ok(keys.includes("omniroute/cc/a"));
  assert.ok(keys.includes("omniroute/mix"));
  assert.ok(keys.includes("omniroute/auto"));
  const named = context.models.get("omniroute/cc/a") as Record<string, unknown>;
  assert.equal(named.name, "Claude - Claude A");
  assert.equal(named.modelID, "cc/a");
});

test("prefers the stored OpenCode credential over the environment key", async () => {
  const seen: string[] = [];
  const context = createContext();
  await setupOmniRoute(
    context,
    deps({
      fetchers: {
        models: async (_baseURL, apiKey) => {
          seen.push(apiKey);
          return [{ id: "cc/a" }];
        },
        combos: async () => [],
        autoCombos: async () => [],
        providers: async () => [],
        enrichment: async () => new Map(),
      },
      connectionKey: async () => "stored-key",
    }),
  );
  assert.deepEqual(seen, ["stored-key"]);
  assert.equal(
    (context.providers.get("omniroute")?.settings as Record<string, unknown>).apiKey,
    "stored-key",
  );
});

test("uses the management key for management endpoints with inference fallback", async () => {
  const seen: Record<string, string> = {};
  const context = createContext();
  const fetchers: OmniRouteFetchers = {
    models: async () => [{ id: "cc/a" }],
    combos: async (_baseURL: string, apiKey: string) => {
      seen.combos = apiKey;
      return [];
    },
    autoCombos: async () => [],
    providers: async () => [],
    enrichment: async () => new Map(),
  };
  await setupOmniRoute(
    context,
    deps({
      config: async () => ({ ok: true, value: { ...baseConfig, managementKey: "mgmt-key" } }),
      fetchers,
    }),
  );
  assert.equal(seen.combos, "mgmt-key");

  const fallback: Record<string, string> = {};
  await setupOmniRoute(
    createContext(),
    deps({
      fetchers: {
        ...fetchers,
        combos: async (_baseURL: string, apiKey: string) => {
          fallback.combos = apiKey;
          return [];
        },
      },
    }),
  );
  assert.equal(fallback.combos, "test-key");
});

test("warns and skips when no key exists anywhere", async () => {
  const warnings: string[] = [];
  await setupOmniRoute(
    createContext(),
    deps({
      config: async () => ({ ok: true, value: { ...baseConfig, apiKey: "" } }),
      warn: (message) => warnings.push(message),
    }),
  );
  assert.deepEqual(warnings, ["opencode-9router-v2: omniroute API key is not configured"]);
});

test("serves last-known-good from disk when the gateway is down", async () => {
  const warnings: string[] = [];
  const infos: string[] = [];
  const context = createContext();
  const diskSnapshot = {
    models: [{ id: "cc/cached" }],
    combos: [],
    autoCombos: [],
    providers: [],
    enrichment: [],
    fetchedAt: 1,
  };
  await setupOmniRoute(
    context,
    deps({
      fetchers: {
        models: async () => {
          throw new Error("gateway down");
        },
        combos: async () => {
          throw new Error("gateway down");
        },
        autoCombos: async () => {
          throw new Error("gateway down");
        },
        providers: async () => [],
        enrichment: async () => {
          throw new Error("gateway down");
        },
      },
      readSnapshot: async () => diskSnapshot,
      warn: (message) => warnings.push(message),
      info: (message) => infos.push(message),
    }),
  );
  assert.equal(context.transforms(), 1);
  assert.ok([...context.models.keys()].includes("omniroute/cc/cached"));
  assert.ok(warnings.some((message) => message.includes("last-known-good")));
});

test("fails soft without a catalog when the gateway and cache are empty", async () => {
  const warnings: string[] = [];
  const context = createContext();
  await setupOmniRoute(
    context,
    deps({
      fetchers: {
        models: async () => {
          throw new Error("down");
        },
        combos: async () => [],
        autoCombos: async () => [],
        providers: async () => [],
        enrichment: async () => new Map(),
      },
      warn: (message) => warnings.push(message),
    }),
  );
  assert.equal(context.transforms(), 0);
  assert.deepEqual(warnings, [
    "opencode-9router-v2: omniroute model discovery failed; OmniRoute will be unavailable",
  ]);
});

test("keeps normal models when optional endpoints fail", async () => {
  const warnings: string[] = [];
  const context = createContext();
  await setupOmniRoute(
    context,
    deps({
      fetchers: {
        models: async () => [{ id: "cc/a" }],
        combos: async (_baseURL, _apiKey, options) => {
          // Mirrors the real client: report, then fail so last-known is kept.
          options?.onSourceError?.("/api/combos", "omniroute request returned HTTP 403");
          throw new Error("combos down");
        },
        autoCombos: async () => {
          throw new Error("auto down");
        },
        providers: async () => {
          throw new Error("providers down");
        },
        enrichment: async () => {
          throw new Error("enrichment down");
        },
      },
      warn: (message) => warnings.push(message),
    }),
  );
  assert.equal(context.transforms(), 1);
  assert.ok([...context.models.keys()].includes("omniroute/cc/a"));
  assert.ok(
    warnings.some((message) =>
      message.includes("/api/combos unavailable (omniroute request returned HTTP 403)"),
    ),
  );
  assert.ok(!warnings.some((message) => message.includes("/api/combos/auto unavailable")));
});

test("registers the native integration and sanitizes Gemini tools", async () => {
  const methods: unknown[] = [];
  let updatedName = "";
  const seen: { providerID?: string; model?: unknown }[] = [];
  const language = {
    doGenerate: (options: unknown) => options,
    doStream: (options: unknown) => options,
  };
  const context: TestContext = {
    ...createContext(),
    integration: {
      transform: (update: (draft: unknown) => void) => {
        update({
          update: (_id: string, apply: (info: { name?: string }) => void) => {
            const info: { name?: string } = {};
            apply(info);
            updatedName = info.name ?? "";
          },
          method: { update: (input: unknown) => methods.push(input) },
        });
        return Promise.resolve({ dispose: async () => undefined });
      },
    },
    aisdk: {
      hook: (
        _name: string,
        callback: (input: { model?: { providerID?: string; id?: string }; language?: unknown }) => void,
      ) => {
        const input = { model: { providerID: "omniroute", id: "google/gemini-2.0-flash" }, language };
        callback(input);
        seen.push({ providerID: input.model.providerID, model: input.language });
        // A foreign provider must pass through untouched.
        const foreign = { model: { providerID: "other", id: "google/gemini-2.0-flash" }, language };
        callback(foreign);
        seen.push({ providerID: foreign.model.providerID, model: foreign.language });
        return Promise.resolve({ dispose: async () => undefined });
      },
    },
  };
  await setupOmniRoute(context, deps());
  assert.equal(updatedName, "OmniRoute");
  assert.equal(methods.length, 2);
  assert.notEqual(seen[0]?.model, language);
  assert.equal(seen[1]?.model, language);
});

test("survives hosts without integration or aisdk domains", async () => {
  const context = createContext();
  await setupOmniRoute(
    { provider: context.provider, integration: {}, aisdk: {} },
    deps(),
  );
  assert.equal(context.transforms(), 1);
});

test("reloads once when a stale snapshot upgrades in the background", async () => {
  const context = createContext();
  let calls = 0;
  const diskSnapshot = {
    models: [{ id: "cc/old" }],
    combos: [],
    autoCombos: [],
    providers: [],
    enrichment: [],
    fetchedAt: 1,
  };
  await setupOmniRoute(
    context,
    deps({
      config: async () => ({ ok: true, value: { ...baseConfig, cacheTtlMs: 1000 } }),
      fetchers: {
        models: async () => {
          calls += 1;
          if (calls === 1) throw new Error("down");
          return [{ id: "cc/new" }];
        },
        combos: async () => [],
        autoCombos: async () => [],
        providers: async () => [],
        enrichment: async () => new Map(),
      },
      readSnapshot: async () => diskSnapshot,
      now: () => 50_000,
      warn: () => undefined,
    }),
  );
  assert.equal(calls, 2);
  assert.equal(context.reloads(), 1);
  assert.ok([...context.models.keys()].includes("omniroute/cc/old"));
});

test("coexistence: 9Router and OmniRoute register independently", async () => {
  const warnings: string[] = [];
  const infos: string[] = [];
  const plugin = createPlugin({
    config: async () => ({ ok: true, value: { apiKey: "nine", baseURL: "http://nine/v1" } }),
    discover: async () => [{ id: "ocg/model", reasoning: false, thinkingCanDisable: false }],
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message),
    omniroute: {
      ...deps({
        fetchers: {
          models: async () => [{ id: "cc/a" }],
          combos: async () => [],
          autoCombos: async () => [],
          providers: async () => [],
          enrichment: async () => new Map(),
        },
      }),
      warn: undefined,
      info: undefined,
    } as PartialOmniRouteSetupDeps,
  });
  const { editor, providers, models } = createEditor();
  let transforms = 0;
  await plugin.setup({
    provider: {
      transform: (async (update: (editor: ProviderEditor) => void) => {
        transforms += 1;
        update(editor);
        return { dispose: async () => undefined };
      }) as never,
    },
  } as never);
  assert.equal(transforms, 2);
  assert.ok(providers.get("9router"));
  assert.ok(providers.get("omniroute"));
  assert.notEqual(
    (providers.get("9router")?.settings as Record<string, unknown>).baseURL,
    (providers.get("omniroute")?.settings as Record<string, unknown>).baseURL,
  );
  assert.ok([...models.keys()].some((key) => key.startsWith("9router/")));
  assert.ok([...models.keys()].some((key) => key.startsWith("omniroute/")));
  assert.deepEqual(warnings, []);
});

test("OmniRoute failure cannot break 9Router registration", async () => {
  const warnings: string[] = [];
  const plugin = createPlugin({
    config: async () => ({ ok: true, value: { apiKey: "nine", baseURL: "http://nine/v1" } }),
    discover: async () => [{ id: "ocg/model", reasoning: false, thinkingCanDisable: false }],
    warn: (message) => warnings.push(message),
    omniroute: {
      config: async () => {
        throw new Error("omniroute config blew up");
      },
    },
  });
  const { editor, providers } = createEditor();
  await plugin.setup({
    provider: {
      transform: (async (update: (editor: ProviderEditor) => void) => {
        update(editor);
        return { dispose: async () => undefined };
      }) as never,
    },
  } as never);
  assert.ok(providers.get("9router"));
  assert.equal(providers.get("omniroute"), undefined);
  assert.deepEqual(warnings, ["opencode-9router-v2: invalid omniroute configuration"]);
});

test("reports config errors and unusable catalogs without throwing", async () => {
  const configWarnings: string[] = [];
  await setupOmniRoute(
    createContext(),
    deps({
      config: async () => ({
        ok: false as const,
        error: { message: "OPENCODE_OMNIROUTE_URL must use http or https" } as never,
      }),
      warn: (message) => configWarnings.push(message),
    }),
  );
  assert.deepEqual(configWarnings, [
    "opencode-9router-v2: OPENCODE_OMNIROUTE_URL must use http or https",
  ]);

  const emptyWarnings: string[] = [];
  const emptyContext = createContext();
  await setupOmniRoute(
    emptyContext,
    deps({
      fetchers: {
        models: async () => [{ id: "  not-a-route  " }],
        combos: async () => [],
        autoCombos: async () => [],
        providers: async () => [],
        enrichment: async () => new Map(),
      },
      warn: (message) => emptyWarnings.push(message),
    }),
  );
  assert.equal(emptyContext.transforms(), 0);
  assert.deepEqual(emptyWarnings, ["opencode-9router-v2: omniroute returned no usable models"]);
});

test("warns instead of throwing when the inventory write fails", async () => {
  const warnings: string[] = [];
  const context = createContext();
  const broken: TestContext = {
    ...context,
    provider: {
      ...context.provider,
      transform: (async () => {
        throw new Error("editor shape changed");
      }) as TestContext["provider"]["transform"],
    },
  };
  await setupOmniRoute(broken, deps({ warn: (message) => warnings.push(message) }));
  assert.deepEqual(warnings, [
    "opencode-9router-v2: failed to register OmniRoute models; continuing without them",
  ]);
});

test("serves memory hits without touching the network", async () => {
  const shared = createOmniRouteCache({ ttlMs: 60_000 });
  const warnings: string[] = [];
  let calls = 0;
  const counting: OmniRouteFetchers = {
    models: async () => {
      calls += 1;
      return [{ id: "cc/a" }];
    },
    combos: async () => [],
    autoCombos: async () => [],
    providers: async () => [],
    enrichment: async () => new Map(),
  };
  const first = createContext();
  await setupOmniRoute(first, deps({ fetchers: counting, createCache: () => shared }));
  assert.equal(calls, 1);
  assert.equal(first.transforms(), 1);

  const second = createContext();
  await setupOmniRoute(
    second,
    deps({
      fetchers: {
        models: async () => {
          calls += 1;
          return [{ id: "cc/changed" }];
        },
        combos: async () => [],
        autoCombos: async () => [],
        providers: async () => [],
        enrichment: async () => new Map(),
      },
      createCache: () => shared,
      warn: (message) => warnings.push(message),
    }),
  );
  assert.equal(calls, 1);
  assert.equal(second.transforms(), 1);
  assert.deepEqual(warnings, []);
});

test("cools down shared caches and recovers through the background refresh", async () => {
  const shared = createOmniRouteCache({ ttlMs: 60_000 });
  let calls = 0;
  const flaky = {
    models: async () => {
      calls += 1;
      throw new Error("down");
    },
    combos: async () => [],
    autoCombos: async () => [],
    providers: async () => [],
    enrichment: async () => new Map(),
  };
  const diskSnapshot = {
    models: [{ id: "cc/old" }],
    combos: [],
    autoCombos: [],
    providers: [],
    enrichment: [],
    fetchedAt: 1,
  };
  const first = createContext();
  await setupOmniRoute(
    first,
    deps({ fetchers: flaky, createCache: () => shared, readSnapshot: async () => diskSnapshot }),
  );
  assert.equal(first.transforms(), 1);
  // Foreground plus exactly one background attempt.
  assert.equal(calls, 2);

  const second = createContext();
  await setupOmniRoute(
    second,
    deps({ fetchers: flaky, createCache: () => shared, readSnapshot: async () => undefined }),
  );
  assert.equal(second.transforms(), 1);
});

test("keeps the catalog when the background refresh finds nothing new", async () => {
  const context = createContext();
  let calls = 0;
  const diskSnapshot = {
    models: [{ id: "cc/a" }],
    combos: [],
    autoCombos: [],
    providers: [],
    enrichment: [],
    fetchedAt: 1,
  };
  await setupOmniRoute(
    context,
    deps({
      fetchers: {
        models: async () => {
          calls += 1;
          if (calls === 1) throw new Error("down");
          return [{ id: "cc/a" }];
        },
        combos: async () => [],
        autoCombos: async () => [],
        providers: async () => [],
        enrichment: async () => new Map(),
      },
      readSnapshot: async () => diskSnapshot,
      warn: () => undefined,
    }),
  );
  assert.equal(calls, 2);
  assert.equal(context.reloads(), 0);
});

test("warns when the catalog reload or snapshot write fails", async () => {
  const warnings: string[] = [];
  const diskSnapshot = {
    models: [{ id: "cc/old" }],
    combos: [],
    autoCombos: [],
    providers: [],
    enrichment: [],
    fetchedAt: 1,
  };
  const context = createContext();
  const reloading = {
    ...context,
    provider: {
      ...context.provider,
      reload: async () => {
        throw new Error("reload blew up");
      },
    },
  };
  let calls = 0;
  await setupOmniRoute(
    reloading,
    deps({
      config: async () => ({ ok: true, value: { ...baseConfig, cacheTtlMs: 1000 } }),
      fetchers: {
        models: async () => {
          calls += 1;
          if (calls === 1) throw new Error("down");
          return [{ id: "cc/new" }];
        },
        combos: async () => [],
        autoCombos: async () => [],
        providers: async () => [],
        enrichment: async () => new Map(),
      },
      readSnapshot: async () => diskSnapshot,
      writeSnapshot: async () => {
        throw new Error("disk blew up");
      },
      now: () => 50_000,
      warn: (message) => warnings.push(message),
    }),
  );
  assert.ok(warnings.some((message) => message.includes("reload failed")));
});

test("survives hostile integration and credential hooks", async () => {
  const warnings: string[] = [];
  const context = createContext();
  await setupOmniRoute(
    {
      provider: context.provider,
      integration: {
        transform: () => {
          throw new Error("host refused");
        },
      },
      aisdk: {
        hook: () => Promise.reject(new Error("hook refused")),
      },
    },
    deps({ warn: (message) => warnings.push(message) }),
  );
  assert.equal(context.transforms(), 1);
  assert.deepEqual(warnings, [
    "opencode-9router-v2: omniroute connect action unavailable; continuing",
    "opencode-9router-v2: omniroute Gemini sanitization unavailable; continuing",
  ]);

  // Throwing credential lookups and snapshot helpers also degrade gracefully.
  const second = createContext();
  await setupOmniRoute(
    second,
    deps({
      connectionKey: async () => {
        throw new Error("credential store blew up");
      },
      readSnapshot: async () => {
        throw new Error("disk blew up");
      },
      snapshotFile: () => {
        throw new Error("bad provider id");
      },
    }),
  );
  assert.equal(second.transforms(), 1);

  // A refresh that rejects outright still serves last-known-good.
  const third = createContext();
  const failingCache = createOmniRouteCache({ ttlMs: 1000 });
  const refresh = failingCache.refresh.bind(failingCache);
  let attempts = 0;
  const throwingCache = {
    ...failingCache,
    refresh: (async () => {
      attempts += 1;
      throw new Error("cache blew up");
    }) as typeof refresh,
  };
  const thirdWarnings: string[] = [];
  await setupOmniRoute(
    third,
    deps({
      createCache: () => throwingCache,
      warn: (message) => thirdWarnings.push(message),
    }),
  );
  assert.equal(attempts, 1);
  assert.equal(third.transforms(), 0);
  assert.deepEqual(thirdWarnings, [
    "opencode-9router-v2: omniroute model discovery failed; OmniRoute will be unavailable",
  ]);
});

test("skips Gemini hooks when sanitization is disabled", async () => {
  let hooked = false;
  const context = createContext();
  await setupOmniRoute(
    {
      provider: context.provider,
      aisdk: {
        hook: () => {
          hooked = true;
          return Promise.resolve({ dispose: async () => undefined });
        },
      },
    },
    deps({ config: async () => ({ ok: true, value: { ...baseConfig, geminiSanitization: false } }) }),
  );
  assert.equal(hooked, false);
  assert.equal(context.transforms(), 1);
});

test("a throwing OmniRoute refresh cannot break 9Router", async () => {
  const warnings: string[] = [];
  const plugin = createPlugin({
    config: async () => ({ ok: true, value: { apiKey: "nine", baseURL: "http://nine/v1" } }),
    discover: async () => [{ id: "ocg/model", reasoning: false, thinkingCanDisable: false }],
    warn: (message) => warnings.push(message),
    omniroute: {
      config: async () => ({ ok: true, value: { ...baseConfig } }),
      createCache: () => {
        throw new Error("cache blew up");
      },
    },
  });
  const { editor, providers } = createEditor();
  await plugin.setup({
    provider: {
      transform: (async (update: (editor: ProviderEditor) => void) => {
        update(editor);
        return { dispose: async () => undefined };
      }) as never,
    },
  } as never);
  assert.ok(providers.get("9router"));
  assert.equal(providers.get("omniroute"), undefined);
  assert.deepEqual(warnings, ["opencode-9router-v2: omniroute setup failed; 9Router is unaffected"]);
});

test("wires the default dependencies end to end", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omniroute-defaults-"));
  const savedDataDir = process.env.OPENCODE_DATA_DIR;
  const savedURL = process.env.OPENCODE_OMNIROUTE_URL;
  const savedKey = process.env.OPENCODE_OMNIROUTE_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.OPENCODE_DATA_DIR = directory;
  process.env.OPENCODE_OMNIROUTE_URL = "http://gw:20128";
  process.env.OPENCODE_OMNIROUTE_API_KEY = "live-key";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "cc/a" }] }), { status: 200 });
    }
    if (url.endsWith("/api/combos")) {
      return new Response(JSON.stringify({ combos: [] }), { status: 200 });
    }
    if (url.endsWith("/api/combos/auto")) {
      return new Response("missing", { status: 404 });
    }
    return new Response("denied", { status: 500 });
  }) as typeof fetch;
  const warnings: string[] = [];
  const context = createContext();
  try {
    await setupOmniRoute(context, {
      warn: (message) => warnings.push(message),
      info: () => undefined,
    });
  } finally {
    if (savedDataDir === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = savedDataDir;
    if (savedURL === undefined) delete process.env.OPENCODE_OMNIROUTE_URL;
    else process.env.OPENCODE_OMNIROUTE_URL = savedURL;
    if (savedKey === undefined) delete process.env.OPENCODE_OMNIROUTE_API_KEY;
    else process.env.OPENCODE_OMNIROUTE_API_KEY = savedKey;
    globalThis.fetch = savedFetch;
  }
  assert.equal(context.transforms(), 1);
  assert.ok(context.providers.get("omniroute"));
  assert.deepEqual(await readdir(join(directory, "plugins")), ["omniroute-omniroute.json"]);
  assert.ok(warnings.some((message) => message.includes("/api/pricing/models unavailable")));
});

test("exposes console-backed default sinks", () => {
  const defaults = defaultOmniRouteDeps();
  const savedWarn = console.warn;
  const savedInfo = console.info;
  const warned: unknown[][] = [];
  const infos: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warned.push(args);
  };
  console.info = (...args: unknown[]) => {
    infos.push(args);
  };
  try {
    defaults.warn("w");
    defaults.info?.("i");
  } finally {
    console.warn = savedWarn;
    console.info = savedInfo;
  }
  assert.deepEqual(warned, [["w"]]);
  assert.deepEqual(infos, [["i"]]);
});

test("tolerates throwing observability sinks", async () => {
  const context = createContext();
  await setupOmniRoute(
    context,
    deps({
      fetchers: {
        models: async () => {
          throw new Error("down");
        },
        combos: async () => [],
        autoCombos: async () => [],
        providers: async () => [],
        enrichment: async () => new Map(),
      },
      warn: () => {
        throw new Error("sink blew up");
      },
      info: () => {
        throw new Error("sink blew up");
      },
    }),
  );
  assert.equal(context.transforms(), 0);

  // The info sink throwing on the success path is equally harmless.
  const succeeding = createContext();
  await setupOmniRoute(
    succeeding,
    deps({
      info: () => {
        throw new Error("sink blew up");
      },
    }),
  );
  assert.equal(succeeding.transforms(), 1);
});

test("survives hostile integration drafts and hook registrations", async () => {
  // draft.update throws, method registration still attempted.
  const methods: unknown[] = [];
  const first = createContext();
  await setupOmniRoute(
    {
      provider: first.provider,
      integration: {
        transform: (update: (draft: unknown) => void) => {
          update({
            update: () => {
              throw new Error("unknown integration");
            },
            method: { update: (input: unknown) => methods.push(input) },
          });
          return undefined;
        },
      },
    },
    deps(),
  );
  assert.equal(first.transforms(), 1);
  assert.equal(methods.length, 2);

  // method.update throws.
  const second = createContext();
  const warnings: string[] = [];
  await setupOmniRoute(
    {
      provider: second.provider,
      integration: {
        transform: (update: (draft: unknown) => void) => {
          update({
            update: (_id: string, apply: (info: { name?: string }) => void) => apply({}),
            method: {
              update: () => {
                throw new Error("methods refused");
              },
            },
          });
          return undefined;
        },
      },
    },
    deps({ warn: (message) => warnings.push(message) }),
  );
  assert.equal(second.transforms(), 1);
  assert.deepEqual(warnings, []);

  // transform returns a rejecting promise.
  const third = createContext();
  const thirdWarnings: string[] = [];
  await setupOmniRoute(
    {
      provider: third.provider,
      integration: {
        transform: () => Promise.reject(new Error("host refused")),
      },
    },
    deps({ warn: (message) => thirdWarnings.push(message) }),
  );
  assert.equal(third.transforms(), 1);
  assert.deepEqual(thirdWarnings, [
    "opencode-9router-v2: omniroute connect action unavailable; continuing",
  ]);

  // hook callback throwing on a poisoned model record.
  const seen: unknown[] = [];
  const fourth = createContext();
  await setupOmniRoute(
    {
      provider: fourth.provider,
      aisdk: {
        hook: (
          _name: string,
          callback: (input: unknown) => void,
        ) => {
          const poisoned = {};
          Object.defineProperty(poisoned, "model", {
            get: () => {
              throw new Error("getter blew up");
            },
          });
          callback(poisoned);
          callback(null);
          callback({ model: { providerID: "omniroute", id: 42 }, language: "x" });
          seen.push("ran");
          return Promise.resolve({ dispose: async () => undefined });
        },
      },
    },
    deps(),
  );
  assert.deepEqual(seen, ["ran"]);
  assert.equal(fourth.transforms(), 1);

  // hook registration throwing synchronously.
  const fifth = createContext();
  const fifthWarnings: string[] = [];
  await setupOmniRoute(
    {
      provider: fifth.provider,
      aisdk: {
        hook: () => {
          throw new Error("hook refused");
        },
      },
    },
    deps({ warn: (message) => fifthWarnings.push(message) }),
  );
  assert.equal(fifth.transforms(), 1);
  assert.deepEqual(fifthWarnings, [
    "opencode-9router-v2: omniroute Gemini sanitization unavailable; continuing",
  ]);
});

test("filters by usable providers when enabled, keeping the catalog on failure", async () => {
  const usableContext = createContext();
  await setupOmniRoute(
    usableContext,
    deps({
      config: async () => ({ ok: true, value: { ...baseConfig, usableOnly: true } }),
      fetchers: {
        models: async () => [{ id: "cc/a" }, { id: "kr/b" }],
        combos: async () => [],
        autoCombos: async () => [],
        providers: async () => [{ id: "1", provider: "claude", isActive: true, testStatus: "active" }],
        enrichment: async () =>
          new Map([
            ["cc/a", { providerAlias: "cc", providerCanonical: "claude" }],
            ["kr/b", { providerAlias: "kr", providerCanonical: "kiro" }],
          ]),
      },
    }),
  );
  assert.deepEqual(
    [...usableContext.models.keys()],
    ["omniroute/cc/a"],
  );

  // Providers endpoint down: fail open, keep everything.
  const openContext = createContext();
  await setupOmniRoute(
    openContext,
    deps({
      config: async () => ({ ok: true, value: { ...baseConfig, usableOnly: true } }),
      fetchers: {
        models: async () => [{ id: "cc/a" }, { id: "kr/b" }],
        combos: async () => [],
        autoCombos: async () => [],
        providers: async () => {
          throw new Error("providers down");
        },
        enrichment: async () => new Map(),
      },
    }),
  );
  assert.deepEqual([...openContext.models.keys()], ["omniroute/cc/a", "omniroute/kr/b"]);
});

test("publishes raw names when enrichment is disabled", async () => {
  const context = createContext();
  await setupOmniRoute(
    context,
    deps({
      config: async () => ({ ok: true, value: { ...baseConfig, enrichment: false } }),
      fetchers: {
        models: async () => [{ id: "cc/a" }],
        combos: async () => [],
        autoCombos: async () => [],
        providers: async () => [],
        enrichment: async () => {
          throw new Error("must not run");
        },
      },
    }),
  );
  assert.equal((context.models.get("omniroute/cc/a") as Record<string, unknown>).name, "cc/a");
});

test("tolerates unreadable snapshots and unwritable disks", async () => {
  const context = createContext();
  await setupOmniRoute(
    context,
    deps({
      readSnapshot: async () => {
        throw new Error("disk blew up");
      },
    }),
  );
  assert.equal(context.transforms(), 1);

  const nowrite = createContext();
  await setupOmniRoute(
    nowrite,
    deps({
      writeSnapshot: async () => {
        throw new Error("disk blew up");
      },
    }),
  );
  assert.equal(nowrite.transforms(), 1);
});

test("contains background refresh explosions", async () => {
  const context = createContext();
  let calls = 0;
  const diskSnapshot = {
    models: [{ id: "cc/a" }],
    combos: [],
    autoCombos: [],
    providers: [],
    enrichment: [],
    fetchedAt: 1,
  };
  await setupOmniRoute(
    context,
    deps({
      fetchers: {
        models: async () => {
          calls += 1;
          if (calls === 1) throw new Error("down");
          return null as never;
        },
        combos: async () => [],
        autoCombos: async () => [],
        providers: async () => [],
        enrichment: async () => new Map(),
      },
      readSnapshot: async () => diskSnapshot,
      warn: () => undefined,
    }),
  );
  assert.equal(calls, 2);
  assert.equal(context.transforms(), 1);
  assert.equal(context.reloads(), 0);
});

test("9Router config failure does not stop OmniRoute", async () => {
  const warnings: string[] = [];
  const collect = (message: string): void => {
    warnings.push(message);
  };
  const plugin = createPlugin({
    config: async () => ({
      ok: false,
      error: new ConfigError("OPENCODE_9ROUTER_API_KEY is not configured"),
    }),
    discover: async () => {
      throw new Error("should not run");
    },
    warn: collect,
    omniroute: deps({ warn: collect, info: collect }),
  });
  const stores = createEditor();
  let transforms = 0;
  await plugin.setup({
    provider: {
      transform: (async (update: (editor: ProviderEditor) => void) => {
        transforms += 1;
        update(stores.editor);
        return { dispose: async () => undefined };
      }) as never,
    },
  } as never);

  assert.equal(transforms, 1);
  assert.equal(stores.providers.get("9router"), undefined);
  assert.ok(stores.providers.get("omniroute"));
  assert.ok([...stores.models.keys()].includes("omniroute/cc/a"));
  assert.ok(
    warnings.includes("opencode-9router-v2: OPENCODE_9ROUTER_API_KEY is not configured"),
  );
});

test("9Router discovery failure does not stop OmniRoute", async () => {
  const warnings: string[] = [];
  const collect = (message: string): void => {
    warnings.push(message);
  };
  const plugin = createPlugin({
    config: async () => ({ ok: true, value: { apiKey: "nine", baseURL: "http://nine/v1" } }),
    discover: async () => {
      throw new Error("gateway down");
    },
    warn: collect,
    omniroute: deps({ warn: collect, info: collect }),
  });
  const stores = createEditor();
  let transforms = 0;
  await plugin.setup({
    provider: {
      transform: (async (update: (editor: ProviderEditor) => void) => {
        transforms += 1;
        update(stores.editor);
        return { dispose: async () => undefined };
      }) as never,
    },
  } as never);

  assert.equal(transforms, 1);
  assert.equal(stores.providers.get("9router"), undefined);
  assert.ok(stores.providers.get("omniroute"));
  assert.ok(
    warnings.includes("opencode-9router-v2: model discovery failed; 9Router will be unavailable"),
  );
});

test("OmniRoute failure does not stop 9Router", async () => {
  const warnings: string[] = [];
  const plugin = createPlugin({
    config: async () => ({ ok: true, value: { apiKey: "nine", baseURL: "http://nine/v1" } }),
    discover: async () => [{ id: "ocg/model", reasoning: false, thinkingCanDisable: false }],
    warn: (message) => warnings.push(message),
    omniroute: {
      config: async () => {
        throw new Error("omniroute config blew up");
      },
    },
  });
  const stores = createEditor();
  let transforms = 0;
  await plugin.setup({
    provider: {
      transform: (async (update: (editor: ProviderEditor) => void) => {
        transforms += 1;
        update(stores.editor);
        return { dispose: async () => undefined };
      }) as never,
    },
  } as never);

  assert.equal(transforms, 1);
  assert.ok(stores.providers.get("9router"));
  assert.ok([...stores.models.keys()].includes("9router/ocg/model"));
  assert.equal(stores.providers.get("omniroute"), undefined);
  assert.deepEqual(warnings, ["opencode-9router-v2: invalid omniroute configuration"]);
});

test("both providers register independently when both are valid", async () => {
  const warnings: string[] = [];
  const infos: string[] = [];
  const collectWarn = (message: string): void => {
    warnings.push(message);
  };
  const collectInfo = (message: string): void => {
    infos.push(message);
  };
  const plugin = createPlugin({
    config: async () => ({ ok: true, value: { apiKey: "nine", baseURL: "http://nine/v1" } }),
    discover: async () => [{ id: "ocg/model", reasoning: false, thinkingCanDisable: false }],
    warn: collectWarn,
    info: collectInfo,
    omniroute: deps({ warn: collectWarn, info: collectInfo }),
  });
  const stores = createEditor();
  let transforms = 0;
  await plugin.setup({
    provider: {
      transform: (async (update: (editor: ProviderEditor) => void) => {
        transforms += 1;
        update(stores.editor);
        return { dispose: async () => undefined };
      }) as never,
    },
  } as never);

  assert.equal(transforms, 2);
  assert.deepEqual(warnings, []);
  const nine = stores.providers.get("9router") as Record<string, unknown>;
  const omni = stores.providers.get("omniroute") as Record<string, unknown>;
  assert.ok(nine && omni);
  assert.notEqual(
    (nine.settings as Record<string, unknown>).baseURL,
    (omni.settings as Record<string, unknown>).baseURL,
  );
  assert.notEqual(
    (nine.settings as Record<string, unknown>).apiKey,
    (omni.settings as Record<string, unknown>).apiKey,
  );
  assert.ok([...stores.models.keys()].includes("9router/ocg/model"));
  assert.ok([...stores.models.keys()].includes("omniroute/cc/a"));
  assert.ok(infos.some((message) => message.includes("from 9Router")));
  assert.ok(infos.some((message) => message.includes("from OmniRoute")));
});

test("neither provider configured fails soft without crashing", async () => {
  const warnings: string[] = [];
  const plugin = createPlugin({
    config: async () => ({
      ok: false,
      error: new ConfigError("OPENCODE_9ROUTER_API_KEY is not configured"),
    }),
    discover: async () => {
      throw new Error("should not run");
    },
    warn: (message) => warnings.push(message),
    omniroute: {
      config: async () => ({ ok: true, value: undefined }),
    },
  });
  let transforms = 0;
  await plugin.setup({
    provider: {
      transform: (async () => {
        transforms += 1;
        return { dispose: async () => undefined };
      }) as never,
    },
  } as never);

  assert.equal(transforms, 0);
  assert.deepEqual(warnings, [
    "opencode-9router-v2: OPENCODE_9ROUTER_API_KEY is not configured",
  ]);
});

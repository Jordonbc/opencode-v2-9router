import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError } from "../src/config.js";
import defaultPlugin, { createPlugin, PLUGIN_ID } from "../src/index.js";
import type { CatalogDraft } from "../src/provider.js";
import { PROVIDER_ID, PROVIDER_PACKAGE } from "../src/provider.js";

const okConfig = { apiKey: "secret-key", baseURL: "http://router.test/v1" } as const;

type MutableRecord = Record<string, unknown>;

test("exports a native V2 default definition", async () => {
  const plugin = createPlugin({
    config: async () => ({
      ok: true,
      value: { apiKey: "secret-key", baseURL: "http://router.test/v1" },
    }),
    discover: async () => [
      {
        id: "ocg/muse-spark-1.3-contributor",
        reasoning: true,
        thinkingCanDisable: true,
      },
    ],
    warn: () => undefined,
  });

  assert.equal(plugin.id, PLUGIN_ID);
  assert.equal(typeof plugin.setup, "function");
});

test("registers discovered models through catalog.transform", async () => {
  const warnings: string[] = [];
  const infos: string[] = [];
  const providers = new Map<string, MutableRecord>();
  const models = new Map<string, MutableRecord>();
  const id = "ocg/muse-spark-1.3-contributor";
  const seenOptions: unknown[] = [];
  const plugin = createPlugin({
    config: async () => ({ ok: true, value: { ...okConfig } }),
    discover: async (_config, options) => {
      seenOptions.push(options);
      return [
        {
          id,
          reasoning: false,
          thinkingCanDisable: false,
        },
      ];
    },
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message),
  });

  const draft = {
    provider: {
      list: () => [],
      update: (id: string, apply: (provider: MutableRecord) => void) => {
        const provider = providers.get(id) ?? { id, settings: {} };
        providers.set(id, provider);
        apply(provider);
      },
    },
    model: {
      update: (providerID: string, id: string, apply: (model: MutableRecord) => void) => {
        assert.equal(providerID, PROVIDER_ID);
        const model = models.get(id) ?? { limit: {} };
        models.set(id, model);
        apply(model);
      },
    },
  } as unknown as CatalogDraft;

  let transforms = 0;
  await plugin.setup({
    catalog: {
      transform: async (update: (draft: CatalogDraft) => void) => {
        transforms += 1;
        update(draft);
        return { dispose: async () => undefined };
      },
    },
  } as never);

  assert.equal(transforms, 1);
  assert.deepEqual(warnings, []);
  assert.deepEqual(infos, [`opencode-9router-v2: registered 1 model(s) from 9Router`]);
  assert.equal(providers.get(PROVIDER_ID)?.package, PROVIDER_PACKAGE);
  assert.deepEqual([...models.keys()], ["ocg/muse-spark-1.3-contributor"]);
  assert.equal(models.get("ocg/muse-spark-1.3-contributor")?.modelID, "ocg/muse-spark-1.3-contributor");
  assert.equal(seenOptions.length, 1);
  assert.equal(typeof (seenOptions[0] as { onTruncated?: unknown }).onTruncated, "function");
});

test("warns when discovery truncates beyond the model limit", async () => {
  const warnings: string[] = [];
  const plugin = createPlugin({
    config: async () => ({ ok: true, value: { ...okConfig } }),
    discover: async (_config, options) => {
      options?.onTruncated?.(3);
      return [{ id: "a", reasoning: false, thinkingCanDisable: false }];
    },
    warn: (message) => warnings.push(message),
    info: () => undefined,
  });

  await plugin.setup({
    catalog: {
      transform: async (update: (draft: CatalogDraft) => void) => {
        update({
          provider: { list: () => [], update: (_id: string, apply: (p: MutableRecord) => void) => apply({}) },
          model: {
            update: (_providerID: string, _id: string, apply: (m: MutableRecord) => void) =>
              apply({ limit: {} }),
          },
        } as unknown as CatalogDraft);
        return { dispose: async () => undefined };
      },
    },
  } as never);

  assert.deepEqual(warnings, [
    "opencode-9router-v2: ignoring 3 model(s) beyond the 1000 model limit",
  ]);
});

test("stays silent through info when no info sink is configured", async () => {
  const warnings: string[] = [];
  const plugin = createPlugin({
    config: async () => ({ ok: true, value: { ...okConfig } }),
    discover: async () => [{ id: "a", reasoning: false, thinkingCanDisable: false }],
    warn: (message) => warnings.push(message),
  });

  await plugin.setup({
    catalog: {
      transform: async (update: (draft: CatalogDraft) => void) => {
        update({
          provider: { list: () => [], update: (_id: string, apply: (p: MutableRecord) => void) => apply({}) },
          model: {
            update: (_providerID: string, _id: string, apply: (m: MutableRecord) => void) =>
              apply({ limit: {} }),
          },
        } as unknown as CatalogDraft);
        return { dispose: async () => undefined };
      },
    },
  } as never);

  assert.deepEqual(warnings, []);
});

test("warns instead of throwing when catalog.transform fails", async () => {
  const warnings: string[] = [];
  const infos: string[] = [];
  const plugin = createPlugin({
    config: async () => ({ ok: true, value: { ...okConfig } }),
    discover: async () => [{ id: "a", reasoning: false, thinkingCanDisable: false }],
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message),
  });

  await plugin.setup({
    catalog: {
      transform: async () => {
        throw new Error("draft shape changed");
      },
    },
  } as never);

  assert.deepEqual(warnings, [
    "opencode-9router-v2: failed to register 9Router models; continuing without them",
  ]);
  assert.deepEqual(infos, []);
});

test("offline discovery emits one safe warning and does not register", async () => {
  const warnings: string[] = [];
  let transforms = 0;
  const secret = "never-log-this-key";
  const plugin = createPlugin({
    config: async () => ({
      ok: true,
      value: { apiKey: secret, baseURL: "http://router.test/v1" },
    }),
    discover: async () => {
      throw new Error(`network error containing ${secret}`);
    },
    warn: (message) => warnings.push(message),
  });

  await plugin.setup({
    catalog: {
      transform: async () => {
        transforms += 1;
        return { dispose: async () => undefined };
      },
    },
  } as never);

  assert.equal(transforms, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], "opencode-9router-v2: model discovery failed; 9Router will be unavailable");
  assert.doesNotMatch(warnings[0] ?? "", new RegExp(secret, "u"));
});

test("missing configuration warns without failing plugin setup", async () => {
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
  });

  await plugin.setup({} as never);
  assert.deepEqual(warnings, [
    "opencode-9router-v2: OPENCODE_9ROUTER_API_KEY is not configured",
  ]);
});

test("empty discovery warns and does not register", async () => {
  const warnings: string[] = [];
  let transforms = 0;
  const plugin = createPlugin({
    config: async () => ({ ok: true, value: { ...okConfig } }),
    discover: async () => [],
    warn: (message) => warnings.push(message),
  });

  await plugin.setup({
    catalog: {
      transform: async () => {
        transforms += 1;
        return { dispose: async () => undefined };
      },
    },
  } as never);

  assert.equal(transforms, 0);
  assert.deepEqual(warnings, ["opencode-9router-v2: /models returned no usable model IDs"]);
});

test("default dependencies warn and report success through the console", async () => {
  assert.equal(defaultPlugin.id, PLUGIN_ID);
  assert.equal(typeof defaultPlugin.setup, "function");

  const savedURL = process.env.OPENCODE_9ROUTER_URL;
  const savedKey = process.env.OPENCODE_9ROUTER_API_KEY;
  const savedFetch = globalThis.fetch;
  const savedWarn = console.warn;
  const savedInfo = console.info;
  const warnings: string[] = [];
  const infos: string[] = [];
  process.env.OPENCODE_9ROUTER_URL = "http://router.test/v1";
  process.env.OPENCODE_9ROUTER_API_KEY = "secret-key";
  let calls = 0;
  globalThis.fetch = (async () =>
    new Response(calls++ === 0 ? '{"data":[]}' : '{"data":[{"id":"ocg/model"}]}', {
      status: 200,
    })) as typeof fetch;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  console.info = (message?: unknown) => {
    infos.push(String(message));
  };
  try {
    await createPlugin().setup({
      catalog: {
        transform: async () => {
          throw new Error("should not register with no models");
        },
      },
    } as never);
    await defaultPlugin.setup({
      catalog: {
        transform: async (update: (draft: CatalogDraft) => void) => {
          update({
            provider: {
              list: () => [],
              update: (_id: string, apply: (p: MutableRecord) => void) => apply({ settings: {} }),
            },
            model: {
              update: (_providerID: string, _id: string, apply: (m: MutableRecord) => void) =>
                apply({
                  name: "",
                  modelID: "",
                  package: "",
                  enabled: false,
                  status: "",
                  variants: [],
                  limit: {},
                }),
            },
          } as unknown as CatalogDraft);
          return { dispose: async () => undefined };
        },
      },
    } as never);
  } finally {
    if (savedURL === undefined) delete process.env.OPENCODE_9ROUTER_URL;
    else process.env.OPENCODE_9ROUTER_URL = savedURL;
    if (savedKey === undefined) delete process.env.OPENCODE_9ROUTER_API_KEY;
    else process.env.OPENCODE_9ROUTER_API_KEY = savedKey;
    globalThis.fetch = savedFetch;
    console.warn = savedWarn;
    console.info = savedInfo;
  }
  assert.deepEqual(warnings, ["opencode-9router-v2: /models returned no usable model IDs"]);
  assert.deepEqual(infos, ["opencode-9router-v2: registered 1 model(s) from 9Router"]);
});

test("info sink receives the registration summary", async () => {
  const infos: string[] = [];
  await createPlugin({
    config: async () => ({ ok: true, value: { ...okConfig } }),
    discover: async () => [{ id: "ocg/model", reasoning: false, thinkingCanDisable: false }],
    warn: () => undefined,
    info: (message) => infos.push(message),
  }).setup({
    catalog: {
      transform: async (update: (draft: CatalogDraft) => void) => {
        update({
          provider: {
            list: () => [],
            update: (_id: string, apply: (p: MutableRecord) => void) => apply({ settings: {} }),
          },
          model: {
            update: (_providerID: string, _id: string, apply: (m: MutableRecord) => void) =>
              apply({
                name: "",
                modelID: "",
                package: "",
                enabled: false,
                status: "",
                variants: [],
                limit: {},
              }),
          },
        } as unknown as CatalogDraft);
        return { dispose: async () => undefined };
      },
    },
  } as never);
  assert.deepEqual(infos, ["opencode-9router-v2: registered 1 model(s) from 9Router"]);
});

test("a throwing config dependency warns instead of failing setup", async () => {
  const warnings: string[] = [];
  let transforms = 0;
  const secret = "never-log-this-key";
  const plugin = createPlugin({
    config: async () => {
      throw new Error(`config blew up containing ${secret}`);
    },
    discover: async () => {
      throw new Error("should not run");
    },
    warn: (message) => warnings.push(message),
  });

  await plugin.setup({
    catalog: {
      transform: async () => {
        transforms += 1;
        return { dispose: async () => undefined };
      },
    },
  } as never);

  assert.equal(transforms, 0);
  assert.deepEqual(warnings, ["opencode-9router-v2: invalid 9router configuration"]);
  assert.doesNotMatch(warnings[0] ?? "", new RegExp(secret, "u"));
});

test("partial dependency overrides merge with the defaults", async () => {
  const warnings: string[] = [];
  const savedFetch = globalThis.fetch;
  const savedURL = process.env.OPENCODE_9ROUTER_URL;
  const savedKey = process.env.OPENCODE_9ROUTER_API_KEY;
  globalThis.fetch = (async () =>
    new Response('{"data":[{"id":"ocg/model"}]}', { status: 200 })) as typeof fetch;
  process.env.OPENCODE_9ROUTER_URL = "http://router.test/v1";
  process.env.OPENCODE_9ROUTER_API_KEY = "secret-key";
  try {
    let transforms = 0;
    // Only warn is overridden; config/discover fall back to the defaults.
    await createPlugin({ warn: (message) => warnings.push(message) }).setup({
      catalog: {
        transform: async (update: (draft: CatalogDraft) => void) => {
          transforms += 1;
          update({
            provider: {
              list: () => [],
              update: (_id: string, apply: (p: MutableRecord) => void) => apply({ settings: {} }),
            },
            model: {
              update: (_providerID: string, _id: string, apply: (m: MutableRecord) => void) =>
                apply({ limit: {} }),
            },
          } as unknown as CatalogDraft);
          return { dispose: async () => undefined };
        },
      },
    } as never);
    assert.equal(transforms, 1);
    assert.deepEqual(warnings, []);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedURL === undefined) delete process.env.OPENCODE_9ROUTER_URL;
    else process.env.OPENCODE_9ROUTER_URL = savedURL;
    if (savedKey === undefined) delete process.env.OPENCODE_9ROUTER_API_KEY;
    else process.env.OPENCODE_9ROUTER_API_KEY = savedKey;
  }
});

test("a throwing info sink does not break setup", async () => {
  const warnings: string[] = [];
  await createPlugin({
    config: async () => ({ ok: true, value: { ...okConfig } }),
    discover: async () => [{ id: "ocg/model", reasoning: false, thinkingCanDisable: false }],
    warn: (message) => warnings.push(message),
    info: () => {
      throw new Error("info sink blew up");
    },
  }).setup({
    catalog: {
      transform: async (update: (draft: CatalogDraft) => void) => {
        update({
          provider: {
            list: () => [],
            update: (_id: string, apply: (p: MutableRecord) => void) => apply({ settings: {} }),
          },
          model: {
            update: (_providerID: string, _id: string, apply: (m: MutableRecord) => void) =>
              apply({ limit: {} }),
          },
        } as unknown as CatalogDraft);
        return { dispose: async () => undefined };
      },
    },
  } as never);
  assert.deepEqual(warnings, []);
});

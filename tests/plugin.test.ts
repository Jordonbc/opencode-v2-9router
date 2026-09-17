import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError } from "../src/config.js";
import defaultPlugin, { createPlugin, PLUGIN_ID } from "../src/index.js";
import type { ProviderEditor } from "../src/provider.js";
import { PROVIDER_ID, PROVIDER_PACKAGE } from "../src/provider.js";

const okConfig = { apiKey: "secret-key", baseURL: "http://router.test/v1" } as const;

type MutableRecord = Record<string, unknown>;

type EditorStores = {
  readonly editor: ProviderEditor;
  readonly providers: Map<string, MutableRecord>;
  readonly models: Map<string, MutableRecord>;
};

const createEditor = (list: () => readonly unknown[] = () => []): EditorStores => {
  const providers = new Map<string, MutableRecord>();
  const models = new Map<string, MutableRecord>();
  const editor = {
    list: list as never,
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
      set: (_providerID: string, infos: readonly MutableRecord[]) => {
        for (const model of infos) models.set(model.id as string, model);
      },
      update: (providerID: string, id: string, apply: (model: MutableRecord) => void) => {
        assert.equal(providerID, PROVIDER_ID);
        const model = models.get(id) ?? { limit: {} };
        models.set(id, model);
        apply(model);
      },
      remove: () => undefined,
    },
  } as unknown as ProviderEditor;
  return { editor, providers, models };
};

const setupWithProvider = (
  setup: (context: never) => unknown,
  editor: ProviderEditor,
  onTransform?: () => void,
): Promise<{ transforms: number }> => {
  let transforms = 0;
  return Promise.resolve(
    setup({
      provider: {
        transform: async (update: (editor: ProviderEditor) => void) => {
          transforms += 1;
          onTransform?.();
          update(editor);
          return { dispose: async () => undefined };
        },
      },
    } as never),
  ).then(() => ({ transforms }));
};

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

test("registers discovered models through provider.transform", async () => {
  const warnings: string[] = [];
  const infos: string[] = [];
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

  const { editor, providers, models } = createEditor();

  const { transforms } = await setupWithProvider(plugin.setup, editor);

  assert.equal(transforms, 1);
  assert.deepEqual(warnings, []);
  assert.ok(
    infos.includes("opencode-9router-v2: registered 1 model(s) from 9Router"),
    `expected registration summary in ${JSON.stringify(infos)}`,
  );
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

  await setupWithProvider(plugin.setup, createEditor().editor);

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

  await setupWithProvider(plugin.setup, createEditor().editor);

  assert.deepEqual(warnings, []);
});

test("warns instead of throwing when provider.transform fails", async () => {
  const warnings: string[] = [];
  const infos: string[] = [];
  const plugin = createPlugin({
    config: async () => ({ ok: true, value: { ...okConfig } }),
    discover: async () => [{ id: "a", reasoning: false, thinkingCanDisable: false }],
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message),
  });

  await plugin.setup({
    provider: {
      transform: async () => {
        throw new Error("editor shape changed");
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
    provider: {
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
    provider: {
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
      provider: {
        transform: async () => {
          throw new Error("should not register with no models");
        },
      },
    } as never);
    await defaultPlugin.setup({
      provider: {
        transform: async (update: (editor: ProviderEditor) => void) => {
          update(createEditor().editor);
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
    provider: {
      transform: async (update: (editor: ProviderEditor) => void) => {
        update(createEditor().editor);
        return { dispose: async () => undefined };
      },
    },
  } as never);
  assert.deepEqual(infos, ["opencode-9router-v2: registered 1 model(s) from 9Router"]);
});

test("emits transport observability for the Muse route without credentials", async () => {
  const infos: string[] = [];
  const secret = "never-log-this-key";
  const { editor } = createEditor(() => [
    {
      provider: { id: "acme", package: "@opencode/ai/providers/openai" },
      models: new Map([
        [
          "muse-spark-1.3-contributor",
          { id: "muse-spark-1.3-contributor", package: "@opencode/ai/providers/openai", variants: [] },
        ],
      ]),
    },
  ]);
  await createPlugin({
    config: async () => ({ ok: true, value: { apiKey: secret, baseURL: "http://router.test/v1" } }),
    discover: async () => [
      { id: "ocg/muse-spark-1.3-contributor", reasoning: false, thinkingCanDisable: false },
    ],
    warn: () => undefined,
    info: (message) => infos.push(message),
  }).setup({
    provider: {
      transform: async (update: (editor: ProviderEditor) => void) => {
        update(editor);
        return { dispose: async () => undefined };
      },
    },
  } as never);

  const transport = infos.find((message) => message.includes("transport route="));
  assert.ok(transport, `expected transport observability in ${JSON.stringify(infos)}`);
  assert.match(transport ?? "", /route=ocg\/muse-spark-1\.3-contributor/u);
  assert.match(transport ?? "", /provider=acme/u);
  assert.match(transport ?? "", /package=@opencode\/ai\/providers\/openai/u);
  assert.match(transport ?? "", /source=model/u);
  for (const message of infos) assert.doesNotMatch(message, new RegExp(secret, "u"));
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
    provider: {
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
      provider: {
        transform: async (update: (editor: ProviderEditor) => void) => {
          transforms += 1;
          update(createEditor().editor);
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
    provider: {
      transform: async (update: (editor: ProviderEditor) => void) => {
        update(createEditor().editor);
        return { dispose: async () => undefined };
      },
    },
  } as never);
  assert.deepEqual(warnings, []);
});

test("a throwing warn sink cannot break setup", async () => {
  let transforms = 0;
  await createPlugin({
    config: async () => ({ ok: false, error: new ConfigError("nope") }),
    discover: async () => {
      throw new Error("should not run");
    },
    warn: () => {
      throw new Error("warn blew up");
    },
  }).setup({
    provider: {
      transform: async () => {
        transforms += 1;
        return { dispose: async () => undefined };
      },
    },
  } as never);
  assert.equal(transforms, 0);
});

test("a non-array discover return warns instead of throwing", async () => {
  const warnings: string[] = [];
  let transforms = 0;
  await createPlugin({
    config: async () => ({ ok: true, value: { ...okConfig } }),
    discover: (async () => ({ id: "a" })) as never,
    warn: (message) => warnings.push(message),
  }).setup({
    provider: {
      transform: async () => {
        transforms += 1;
        return { dispose: async () => undefined };
      },
    },
  } as never);
  assert.equal(transforms, 0);
  assert.deepEqual(warnings, [
    "opencode-9router-v2: model discovery failed; 9Router will be unavailable",
  ]);
});

test("discover elements with invalid shapes warn instead of registering", async () => {
  const badPayloads: unknown[] = [
    [null],
    ["model"],
    [42],
    [{ id: 42, reasoning: false, thinkingCanDisable: false }],
    [{ id: "a", reasoning: "yes", thinkingCanDisable: false }],
    [{ id: "a", reasoning: false, thinkingCanDisable: false, contextLimit: "100" }],
    [{ id: "a", reasoning: false, thinkingCanDisable: false, outputLimit: "100" }],
    [{ id: `a${String.fromCharCode(0x85)}b`, reasoning: false, thinkingCanDisable: false }],
    [{ id: "a", reasoning: false, thinkingCanDisable: false, contextLimit: 0 }],
    [{ id: "a", reasoning: false, thinkingCanDisable: false, contextLimit: -1 }],
    [{ id: "a", reasoning: false, thinkingCanDisable: false, contextLimit: 1.5 }],
    [{ id: "a", reasoning: false, thinkingCanDisable: false, contextLimit: Number.NaN }],
    [{ id: "a", reasoning: false, thinkingCanDisable: false, contextLimit: Number.POSITIVE_INFINITY }],
    [{ id: "a", reasoning: false, thinkingCanDisable: false, outputLimit: 0 }],
    [{ id: "a", reasoning: false, thinkingCanDisable: false, outputLimit: -1 }],
    [{ id: "a", reasoning: false, thinkingCanDisable: false, outputLimit: 1.5 }],
    [{ id: "a", reasoning: false, thinkingCanDisable: false, outputLimit: Number.NaN }],
    [{ id: "a", reasoning: false, thinkingCanDisable: false, outputLimit: Number.POSITIVE_INFINITY }],
  ];
  for (const payload of badPayloads) {
    const warnings: string[] = [];
    let transforms = 0;
    await createPlugin({
      config: async () => ({ ok: true, value: { ...okConfig } }),
      discover: (async () => payload) as never,
      warn: (message) => warnings.push(message),
    }).setup({
      provider: {
        transform: async () => {
          transforms += 1;
          return { dispose: async () => undefined };
        },
      },
    } as never);
    assert.equal(transforms, 0);
    assert.deepEqual(warnings, [
      "opencode-9router-v2: model discovery failed; 9Router will be unavailable",
    ]);
  }
});

test("deduplicates ambiguous-route warnings across transform replays", async () => {
  const warnings: string[] = [];
  let replay: ((editor: ProviderEditor) => void) | undefined;
  await createPlugin({
    config: async () => ({ ok: true, value: { ...okConfig } }),
    discover: async () => [{ id: "route/model", reasoning: false, thinkingCanDisable: false }],
    warn: (message) => warnings.push(message),
    info: () => undefined,
  }).setup({
    provider: {
      transform: async (update: (editor: ProviderEditor) => void) => {
        replay = update;
        return { dispose: async () => undefined };
      },
    },
  } as never);

  const makeEditor = (): ProviderEditor => {
    const { editor } = createEditor(() => [
      {
        provider: { id: "a", package: "@opencode/ai/providers/openai" },
        models: new Map([["model", { variants: [] }]]),
      },
      {
        provider: { id: "b", package: "@opencode/ai/providers/anthropic" },
        models: new Map([["model", { variants: [] }]]),
      },
    ]);
    return editor;
  };

  replay?.(makeEditor());
  replay?.(makeEditor());
  assert.deepEqual(warnings, [
    "opencode-9router-v2: ambiguous direct-model packages for route/model; using @opencode/ai/providers/openai-compatible",
  ]);
});

test("explicit undefined overrides fall back to the defaults", async () => {
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
    await createPlugin({
      config: undefined,
      discover: undefined,
      warn: (message) => warnings.push(message),
    }).setup({
      provider: {
        transform: async (update: (editor: ProviderEditor) => void) => {
          transforms += 1;
          update(createEditor().editor);
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

test("setup summary reports skipped models when the inventory write fails", async () => {
  const warnings: string[] = [];
  const infos: string[] = [];
  await createPlugin({
    config: async () => ({ ok: true, value: { ...okConfig } }),
    discover: async () => [
      {
        id: "good/model",
        reasoning: false,
        thinkingCanDisable: false,
        contextLimit: 1000,
        outputLimit: 100,
      },
      { id: "bad/model", reasoning: false, thinkingCanDisable: false },
    ],
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message),
  }).setup({
    provider: {
      transform: async (update: (editor: ProviderEditor) => void) => {
        const { editor } = createEditor();
        editor.models.set = () => {
          throw new Error("editor shape changed");
        };
        update(editor);
        return { dispose: async () => undefined };
      },
    },
  } as never);
  assert.deepEqual(warnings, [
    "opencode-9router-v2: skipped 2 model(s) that failed to register",
  ]);
  assert.deepEqual(infos, [
    "opencode-9router-v2: registered 0 model(s) from 9Router (skipped 2 model(s))",
  ]);
});

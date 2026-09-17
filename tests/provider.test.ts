import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEditor } from "../src/provider.js";
import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_OUTPUT_LIMIT,
  directModelID,
  directModelPackage,
  directReasoningEfforts,
  directTransport,
  displayName,
  PROVIDER_ID,
  PROVIDER_NAME,
  PROVIDER_PACKAGE,
  reasoningVariants,
  register9RouterCatalog,
  resolveDirectModel,
} from "../src/provider.js";

type MutableRecord = Record<string, unknown>;

const createCatalog = () => {
  const providers = new Map<string, MutableRecord>();
  const models = new Map<string, MutableRecord>();
  const draft = {
    list: () => [],
    get: (id: string) => providers.get(id) as never,
    add: ({ info, models: initial }: { info: MutableRecord; models: readonly unknown[] }) => {
      providers.set(info.id as string, { ...info, settings: { ...(info.settings as object ?? {}) } });
      for (const model of initial) {
        models.set((model as MutableRecord).id as string, model as MutableRecord);
      }
    },
    update: (id: string, update: (provider: MutableRecord) => void) => {
      const provider = providers.get(id) ?? { id, name: id, package: "" };
      providers.set(id, provider);
      update(provider);
    },
    remove: () => undefined,
    models: {
      set: (_providerID: string, infos: readonly MutableRecord[]) => {
        for (const model of infos) models.set(model.id as string, model);
      },
      update: (_providerID: string, id: string, update: (model: MutableRecord) => void) => {
        const model = models.get(id) ?? {
          id,
          modelID: id,
          limit: { context: 0, output: 0 },
        };
        models.set(id, model);
        update(model);
      },
      remove: () => undefined,
    },
  } as unknown as ProviderEditor;

  return { draft, models, providers };
};

const withDirectModel = (id: string, efforts: readonly string[]) => {
  const catalog = createCatalog();
  const direct = {
    provider: { id: "opencode", name: "OpenCode", package: "@opencode/ai/providers/openai" },
    models: new Map([
      [
        id,
        {
          id,
          variants: efforts.map((effort) => ({
            id: effort,
            settings: { reasoningEffort: effort },
          })),
        },
      ],
    ]),
  };
  catalog.draft.list = () => [direct] as never;
  return catalog;
};

const withDirectEntry = (options: {
  directID: string;
  modelPackage?: string;
  providerPackage?: string;
  providerID?: string;
  efforts?: readonly string[];
}) => {
  const catalog = createCatalog();
  const direct = {
    provider: {
      id: options.providerID ?? "opencode",
      name: "Direct",
      package: options.providerPackage ?? "@opencode/ai/providers/openai-compatible",
    },
    models: new Map([
      [
        options.directID,
        {
          id: options.directID,
          ...(options.modelPackage === undefined ? {} : { package: options.modelPackage }),
          variants: (options.efforts ?? []).map((effort) => ({
            id: effort,
            settings: { reasoningEffort: effort },
          })),
        },
      ],
    ]),
  };
  catalog.draft.list = () => [direct] as never;
  return catalog;
};

test("exposes the documented provider identity", () => {
  assert.equal(PROVIDER_ID, "9router");
  assert.equal(PROVIDER_NAME, "9Router");
  assert.equal(PROVIDER_PACKAGE, "@opencode/ai/providers/openai-compatible");
});

test("creates a human-friendly name without changing the route ID", () => {
  assert.equal(displayName("ocg/muse-spark-1.3-contributor"), "Muse Spark 1.3 Contributor (ocg)");
});

test("formats display names for separators, short segments, and bare IDs", () => {
  assert.equal(displayName("plainmodel"), "Plainmodel");
  assert.equal(displayName("ocg/my_model-name"), "MY Model Name (ocg)");
  assert.equal(displayName("ocg/gpt-4o-mini"), "GPT 4o Mini (ocg)");
  assert.equal(displayName("ocg/a--b__c"), "A B C (ocg)");
  assert.equal(displayName("ocg/API"), "API (ocg)");
  assert.equal(displayName("ocg/"), "(ocg)");
  assert.equal(displayName("a/b/c"), "C (a/b)");
  assert.equal(displayName(""), "");
});

test("derives the direct model lookup ID", () => {
  assert.equal(directModelID("ocg/muse-spark-1.3-contributor"), "muse-spark-1.3-contributor");
  assert.equal(directModelID("ocg/foo-review"), "foo");
  assert.equal(directModelID("plain"), "plain");
  assert.equal(directModelID("a/b/c"), "c");
});

test("creates selectable reasoning efforts only for advertised reasoning models", () => {
  const catalog = createCatalog();
  assert.deepEqual(
    reasoningVariants(catalog.draft, {
      id: "unknown/model",
      reasoning: false,
      thinkingCanDisable: true,
    }),
    [],
  );
  assert.deepEqual(reasoningVariants(catalog.draft, {
    id: "unknown/model",
    reasoning: true,
    thinkingCanDisable: false,
  }), [
    { id: "low", settings: { reasoningEffort: "low" } },
    { id: "medium", settings: { reasoningEffort: "medium" } },
    { id: "high", settings: { reasoningEffort: "high" } },
    { id: "xhigh", settings: { reasoningEffort: "xhigh" } },
  ]);
  assert.equal(reasoningVariants(catalog.draft, {
    id: "unknown/model",
    reasoning: true,
    thinkingCanDisable: true,
  })[0]?.id, "none");
});

test("reuses the exact direct OpenCode reasoning levels", () => {
  const catalog = withDirectModel("muse-spark-1.3-contributor", [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  const variants = reasoningVariants(catalog.draft, {
    id: "ocg/muse-spark-1.3-contributor",
    reasoning: true,
    thinkingCanDisable: true,
  });

  assert.deepEqual(variants.map((variant) => variant.id), [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.equal(variants.some((variant) => variant.id === "max"), false);
});

test("keeps a mirrored none effort only when thinking can be disabled", () => {
  const withoutDisable = withDirectModel("m", ["none", "low"]);
  assert.deepEqual(
    reasoningVariants(withoutDisable.draft, {
      id: "ocg/m",
      reasoning: true,
      thinkingCanDisable: false,
    }).map((variant) => variant.id),
    ["low"],
  );

  const withDisable = withDirectModel("m", ["none", "low"]);
  assert.deepEqual(
    reasoningVariants(withDisable.draft, {
      id: "ocg/m",
      reasoning: true,
      thinkingCanDisable: true,
    }).map((variant) => variant.id),
    ["none", "low"],
  );
});

test("falls back to default efforts when every mirrored effort is filtered out", () => {
  const catalog = withDirectModel("m", ["none"]);
  assert.deepEqual(
    reasoningVariants(catalog.draft, {
      id: "ocg/m",
      reasoning: true,
      thinkingCanDisable: false,
    }).map((variant) => variant.id),
    ["low", "medium", "high", "xhigh"],
  );
});

test("ignores 9router records and entries without a matching model", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => [
    {
      provider: { id: "9router" },
      models: new Map([
        ["m", { id: "m", variants: [{ id: "max", settings: { reasoningEffort: "max" } }] }],
      ]),
    },
    {
      provider: { id: "other" },
      models: new Map([["elsewhere", { id: "elsewhere", variants: [] }]]),
    },
  ] as never;

  assert.deepEqual(directReasoningEfforts(catalog.draft, "ocg/m"), []);
});

test("dedupes direct efforts and drops invalid variant settings", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => [
    {
      provider: { id: "opencode" },
      models: new Map([
        [
          "m",
          {
            id: "m",
            variants: [
              { id: "low", settings: { reasoningEffort: "low" } },
              { id: "low", settings: { reasoningEffort: "low" } },
              { id: "bogus", settings: { reasoningEffort: "bogus" } },
              { id: "empty", settings: {} },
              { id: "missing" },
            ],
          },
        ],
      ]),
    },
  ] as never;

  assert.deepEqual(directReasoningEfforts(catalog.draft, "ocg/m"), ["low"]);
});

test("returns no direct efforts when variants carry no usable levels", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => [
    {
      provider: { id: "opencode" },
      models: new Map([["m", { id: "m", variants: [] }]]),
    },
  ] as never;

  assert.deepEqual(directReasoningEfforts(catalog.draft, "ocg/m"), []);
  assert.deepEqual(directReasoningEfforts(createCatalog().draft, "ocg/m"), []);
});

test("registers the exact V2 provider and model transport shape", () => {
  const id = "ocg/muse-spark-1.3-contributor";
  const catalog = withDirectModel("muse-spark-1.3-contributor", [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);

  register9RouterCatalog(
    catalog.draft,
    { apiKey: "secret-key", baseURL: "http://10.0.0.1:20128/v1" },
    [{
      id,
      reasoning: true,
      thinkingCanDisable: true,
      contextLimit: 1_000_000,
      outputLimit: 131_072,
    }],
  );

  assert.deepEqual(catalog.providers.get("9router"), {
    id: "9router",
    name: "9Router",
    activation: "enabled",
    package: PROVIDER_PACKAGE,
    settings: {
      apiKey: "secret-key",
      baseURL: "http://10.0.0.1:20128/v1",
    },
  });
  assert.deepEqual(catalog.models.get(id), {
    id,
    modelID: id,
    providerID: "9router",
    name: "Muse Spark 1.3 Contributor (ocg)",
    package: "@opencode/ai/providers/openai",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    enabled: true,
    status: "active",
    variants: [
      { id: "minimal", settings: { reasoningEffort: "minimal" } },
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "medium", settings: { reasoningEffort: "medium" } },
      { id: "high", settings: { reasoningEffort: "high" } },
      { id: "xhigh", settings: { reasoningEffort: "xhigh" } },
    ],
    time: { released: 0 },
    cost: [],
    limit: { context: 1_000_000, output: 131_072 },
  });
});

test("preserves existing provider settings and registers models without limits", () => {
  const catalog = createCatalog();
  catalog.providers.set("9router", {
    id: "9router",
    name: "old",
    package: "old",
    settings: { keep: "yes" },
  });

  register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [
      { id: "a/b", reasoning: false, thinkingCanDisable: false },
      { id: "plain", reasoning: false, thinkingCanDisable: true },
    ],
  );

  assert.deepEqual(catalog.providers.get("9router"), {
    id: "9router",
    name: "9Router",
    activation: "enabled",
    package: PROVIDER_PACKAGE,
    settings: {
      keep: "yes",
      apiKey: "k",
      baseURL: "http://10.0.0.1:20128/v1",
    },
  });
  assert.deepEqual(catalog.models.get("a/b"), {
    id: "a/b",
    modelID: "a/b",
    providerID: "9router",
    name: "B (a)",
    package: PROVIDER_PACKAGE,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    enabled: true,
    status: "active",
    variants: [],
    time: { released: 0 },
    cost: [],
    limit: { context: DEFAULT_CONTEXT_LIMIT, output: DEFAULT_OUTPUT_LIMIT },
  });
  assert.deepEqual(catalog.models.get("plain"), {
    id: "plain",
    modelID: "plain",
    providerID: "9router",
    name: "Plain",
    package: PROVIDER_PACKAGE,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    enabled: true,
    status: "active",
    variants: [],
    time: { released: 0 },
    cost: [],
    limit: { context: DEFAULT_CONTEXT_LIMIT, output: DEFAULT_OUTPUT_LIMIT },
  });
});

test("writes discovered limits into the staged model info", () => {
  const catalog = createCatalog();

  register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [{ id: "c/model", reasoning: false, thinkingCanDisable: false, contextLimit: 123, outputLimit: 45 }],
  );

  assert.deepEqual(catalog.models.get("c/model")?.limit, { context: 123, output: 45 });
});

test("copies a partial limit without touching the other default", () => {
  const catalog = createCatalog();
  register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [{ id: "c/model", reasoning: false, thinkingCanDisable: false, contextLimit: 123 }],
  );

  assert.deepEqual(catalog.models.get("c/model")?.limit, { context: 123, output: DEFAULT_OUTPUT_LIMIT });
});

test("copies an output-only limit without touching the context default", () => {
  const catalog = createCatalog();
  const outcome = register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [{ id: "c/model", reasoning: false, thinkingCanDisable: false, outputLimit: 456 }],
  );

  assert.deepEqual(catalog.models.get("c/model")?.limit, { context: DEFAULT_CONTEXT_LIMIT, output: 456 });
  assert.deepEqual(outcome, { registered: 1, skipped: 0 });
});

test("mirrors the direct model package for Muse Spark", () => {
  const catalog = withDirectEntry({
    directID: "muse-spark-1.3-contributor",
    modelPackage: "@opencode/ai/providers/openai",
    providerPackage: "@opencode/ai/providers/openai-compatible",
  });

  assert.equal(directModelPackage(catalog.draft, "ocg/muse-spark-1.3-contributor"), "@opencode/ai/providers/openai");

  register9RouterCatalog(
    catalog.draft,
    { apiKey: "secret-key", baseURL: "http://10.0.0.1:20128/v1" },
    [{ id: "ocg/muse-spark-1.3-contributor", reasoning: false, thinkingCanDisable: false }],
  );

  assert.equal(catalog.models.get("ocg/muse-spark-1.3-contributor")?.package, "@opencode/ai/providers/openai");
});

test("mirrors an Anthropic-native direct model package", () => {
  const catalog = withDirectEntry({
    directID: "claude-sonnet-4-5",
    modelPackage: "@opencode/ai/providers/anthropic",
  });

  assert.equal(directModelPackage(catalog.draft, "ocg/claude-sonnet-4-5"), "@opencode/ai/providers/anthropic");

  register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [{ id: "ocg/claude-sonnet-4-5", reasoning: false, thinkingCanDisable: false }],
  );

  assert.equal(catalog.models.get("ocg/claude-sonnet-4-5")?.package, "@opencode/ai/providers/anthropic");
});

test("keeps an OpenAI-compatible direct model on the compatible transport", () => {
  const catalog = withDirectEntry({
    directID: "gpt-5-mini",
    modelPackage: "@opencode/ai/providers/openai-compatible",
  });

  assert.equal(
    directModelPackage(catalog.draft, "ocg/gpt-5-mini"),
    "@opencode/ai/providers/openai-compatible",
  );

  register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [{ id: "ocg/gpt-5-mini", reasoning: false, thinkingCanDisable: false }],
  );

  assert.equal(catalog.models.get("ocg/gpt-5-mini")?.package, PROVIDER_PACKAGE);
});

test("falls back to the generic compatible package for unknown models", () => {
  const catalog = createCatalog();
  assert.equal(directModelPackage(catalog.draft, "ocg/unknown-model"), PROVIDER_PACKAGE);

  register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [{ id: "ocg/unknown-model", reasoning: false, thinkingCanDisable: false }],
  );

  assert.equal(catalog.models.get("ocg/unknown-model")?.package, PROVIDER_PACKAGE);
  assert.equal(catalog.providers.get("9router")?.package, PROVIDER_PACKAGE);
});

test("prefers the model package over its provider package and falls back to the provider", () => {
  const preferred = withDirectEntry({
    directID: "m",
    modelPackage: "@opencode/ai/providers/openai",
    providerPackage: "@opencode/ai/providers/anthropic",
  });
  assert.equal(directModelPackage(preferred.draft, "ocg/m"), "@opencode/ai/providers/openai");

  const providerFallback = withDirectEntry({
    directID: "m",
    providerPackage: "@opencode/ai/providers/anthropic",
  });
  assert.equal(directModelPackage(providerFallback.draft, "ocg/m"), "@opencode/ai/providers/anthropic");
});

test("ignores 9router records when mirroring the transport package", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => [
    {
      provider: { id: "9router", package: "@opencode/ai/providers/openai-compatible" },
      models: new Map([["m", { id: "m", package: "@opencode/ai/providers/openai", variants: [] }]]),
    },
    {
      provider: { id: "opencode", package: "@opencode/ai/providers/anthropic" },
      models: new Map([["m", { id: "m", package: "@opencode/ai/providers/anthropic", variants: [] }]]),
    },
  ] as never;

  assert.equal(directModelPackage(catalog.draft, "ocg/m"), "@opencode/ai/providers/anthropic");
});

test("mirrors transport through the -review direct ID mapping", () => {
  const catalog = withDirectEntry({
    directID: "foo",
    modelPackage: "@opencode/ai/providers/openai",
  });

  assert.equal(directModelPackage(catalog.draft, "ocg/foo-review"), "@opencode/ai/providers/openai");
});

test("mirrored transport keeps the 9router baseURL and apiKey", () => {
  const catalog = withDirectEntry({
    directID: "muse-spark-1.3-contributor",
    modelPackage: "@opencode/ai/providers/openai",
  });
  // Simulate a direct record that also carries upstream connection settings.
  const record = (catalog.draft.list() as unknown as Array<Record<string, unknown>>)[0];
  const models = record?.["models"] as Map<string, Record<string, unknown>>;
  const direct = models.get("muse-spark-1.3-contributor");
  if (direct) {
    direct["settings"] = { baseURL: "https://opencode.ai/zen/go/v1", apiKey: "direct-key" };
  }

  register9RouterCatalog(
    catalog.draft,
    { apiKey: "router-key", baseURL: "http://10.0.0.1:20128/v1" },
    [{ id: "ocg/muse-spark-1.3-contributor", reasoning: false, thinkingCanDisable: false }],
  );

  assert.deepEqual(catalog.providers.get("9router")?.settings, {
    apiKey: "router-key",
    baseURL: "http://10.0.0.1:20128/v1",
  });
  const registered = catalog.models.get("ocg/muse-spark-1.3-contributor");
  assert.equal(registered?.package, "@opencode/ai/providers/openai");
  assert.equal(registered?.modelID, "ocg/muse-spark-1.3-contributor");
  assert.deepEqual((registered as { settings?: unknown } | undefined)?.settings, undefined);
});

test("registration does not mutate the direct model", () => {
  const catalog = withDirectEntry({
    directID: "muse-spark-1.3-contributor",
    modelPackage: "@opencode/ai/providers/openai",
    providerPackage: "@opencode/ai/providers/openai",
    efforts: ["low", "medium"],
  });
  const before = JSON.stringify(catalog.draft.list());

  register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [{
      id: "ocg/muse-spark-1.3-contributor",
      reasoning: true,
      thinkingCanDisable: false,
      contextLimit: 10,
      outputLimit: 20,
    }],
  );

  assert.equal(JSON.stringify(catalog.draft.list()), before);
  // Reasoning mirroring still works alongside transport mirroring.
  assert.deepEqual(
    (catalog.models.get("ocg/muse-spark-1.3-contributor")?.variants as Array<{ id: string }>)
      .map((variant) => variant.id),
    ["low", "medium"],
  );
});

test("reports which provider and direct model supply the mirrored transport", () => {
  const catalog = withDirectEntry({
    directID: "muse-spark-1.3-contributor",
    modelPackage: "@opencode/ai/providers/openai",
    providerPackage: "@opencode/ai/providers/openai-compatible",
    providerID: "opencode",
  });

  assert.deepEqual(directTransport(catalog.draft, "ocg/muse-spark-1.3-contributor"), {
    providerID: "opencode",
    modelID: "muse-spark-1.3-contributor",
    package: "@opencode/ai/providers/openai",
  });
  assert.equal(
    directTransport(createCatalog().draft, "ocg/muse-spark-1.3-contributor"),
    undefined,
  );

  const logged = directTransport(catalog.draft, "ocg/muse-spark-1.3-contributor");
  console.info(
    `9router transport for ocg/muse-spark-1.3-contributor: provider=${logged?.providerID} model=${logged?.modelID} package=${logged?.package}`,
  );
});

test("resolves order-independently across duplicate candidates", () => {
  const reversed = () => {
    const catalog = createCatalog();
    catalog.draft.list = () => [
      {
        provider: { id: "b-second", package: "@opencode/ai/providers/anthropic" },
        models: new Map([
          ["m", { id: "m", package: "@opencode/ai/providers/anthropic", variants: [] }],
        ]),
      },
      {
        provider: { id: "a-first", package: "@opencode/ai/providers/openai" },
        models: new Map([
          ["m", { id: "m", package: "@opencode/ai/providers/openai", variants: [] }],
        ]),
      },
    ] as never;
    return catalog;
  };

  const first = resolveDirectModel(reversed().draft, "zz/m");
  const second = resolveDirectModel(reversed().draft, "zz/m", {});
  assert.deepEqual(first.package, PROVIDER_PACKAGE);
  assert.equal(first.packageSource, "fallback");
  assert.equal(first.candidateCount, 2);
  assert.equal(first.candidate, undefined);
  assert.deepEqual(second, first);
});

test("treats identical duplicate packages as equivalent regardless of order", () => {
  for (const order of ["ab", "ba"] as const) {
    const catalog = createCatalog();
    const a = {
      provider: { id: "a-first", package: "@opencode/ai/providers/openai" },
      models: new Map([
        ["m", { id: "m", package: "@opencode/ai/providers/openai", variants: [{ id: "low", settings: { reasoningEffort: "low" } }] }],
      ]),
    };
    const b = {
      provider: { id: "b-second", package: "@opencode/ai/providers/openai" },
      models: new Map([
        ["m", { id: "m", package: "@opencode/ai/providers/openai", variants: [{ id: "high", settings: { reasoningEffort: "high" } }] }],
      ]),
    };
    catalog.draft.list = () => (order === "ab" ? [a, b] : [b, a]) as never;

    const resolved = resolveDirectModel(catalog.draft, "zz/m");
    assert.equal(resolved.package, "@opencode/ai/providers/openai");
    assert.equal(resolved.packageSource, "model");
    assert.equal(resolved.candidateCount, 2);
    // Deterministic by provider ID, independent of list() order.
    assert.equal(resolved.candidate?.providerID, "a-first");
  }
});

test("uses route/provider affinity to resolve conflicting packages", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => [
    {
      provider: { id: "other", package: "@opencode/ai/providers/anthropic" },
      models: new Map([
        ["m", { id: "m", package: "@opencode/ai/providers/anthropic", variants: [] }],
      ]),
    },
    {
      provider: { id: "acme", package: "@opencode/ai/providers/openai" },
      models: new Map([
        ["m", { id: "m", package: "@opencode/ai/providers/openai", variants: [] }],
      ]),
    },
  ] as never;

  const resolved = resolveDirectModel(catalog.draft, "acme/m");
  assert.equal(resolved.package, "@opencode/ai/providers/openai");
  assert.equal(resolved.packageSource, "model");
  assert.equal(resolved.candidate?.providerID, "acme");

  const warnings: string[] = [];
  const noAffinity = resolveDirectModel(catalog.draft, "zz/m", {
    warn: (message) => warnings.push(message),
  });
  assert.equal(noAffinity.package, PROVIDER_PACKAGE);
  assert.equal(noAffinity.packageSource, "fallback");
  assert.deepEqual(warnings, [
    `opencode-9router-v2: ambiguous direct-model packages for zz/m; using ${PROVIDER_PACKAGE}`,
  ]);
});

test("keeps package and reasoning metadata on the same selected candidate", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => [
    {
      provider: { id: "b-transport" },
      models: new Map([
        [
          "m",
          {
            id: "m",
            package: "@opencode/ai/providers/anthropic",
            variants: [{ id: "low", settings: { reasoningEffort: "low" } }],
          },
        ],
      ]),
    },
    {
      provider: { id: "a-reasoning" },
      models: new Map([
        [
          "m",
          {
            id: "m",
            variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
          },
        ],
      ]),
    },
  ] as never;

  const resolved = resolveDirectModel(catalog.draft, "zz/m");
  assert.equal(resolved.candidate?.providerID, "b-transport");
  assert.equal(resolved.package, "@opencode/ai/providers/anthropic");

  const variants = reasoningVariants(catalog.draft, {
    id: "zz/m",
    reasoning: true,
    thinkingCanDisable: false,
  });
  assert.deepEqual(variants.map((variant) => variant.id), ["low"]);

  register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [{ id: "zz/m", reasoning: true, thinkingCanDisable: false }],
  );
  const registered = catalog.models.get("zz/m");
  assert.equal(registered?.package, "@opencode/ai/providers/anthropic");
  assert.deepEqual(
    (registered?.variants as Array<{ id: string }>).map((variant) => variant.id),
    ["low"],
  );
});

test("skips malformed records and unsafe variant shapes", () => {
  const catalog = createCatalog();
  const good = {
    provider: { id: "good", package: "@opencode/ai/providers/openai" },
    models: new Map([
      ["m", { id: "m", package: "@opencode/ai/providers/openai", variants: [] }],
    ]),
  };
  catalog.draft.list = () => [
    null,
    "record",
    { provider: { id: "9router" }, models: new Map() },
    { provider: null, models: new Map() },
    { provider: { id: "broken-variants" }, models: new Map([["m", { id: "m" }]]) },
    {
      provider: { id: "null-variants" },
      models: new Map([["m", { id: "m", variants: null }]]),
    },
    {
      provider: { id: "string-variants" },
      models: new Map([["m", { id: "m", variants: "low" }]]),
    },
    {
      provider: { id: "array-variants" },
      models: new Map([["m", { id: "m", package: "@opencode/ai/providers/openai", variants: [null, { id: "x" }, { id: "low" }] }]]),
    },
    {
      provider: { id: "primitive-variants" },
      models: new Map([["m", { id: "m", variants: [42, "low", true] }]]),
    },
    {
      provider: { id: "primitive-settings" },
      models: new Map([["m", { id: "m", variants: [{ id: "low", settings: 42 }] }]]),
    },
    {
      provider: { id: "effort-dupe" },
      models: new Map([["m", {
        id: "m",
        variants: [
          { id: "a", settings: { reasoningEffort: "low" } },
          { id: "b", settings: { reasoningEffort: "low" } },
        ],
      }]]),
    },
    { provider: { id: "no-models" } },
    { provider: { id: "no-get", package: "@opencode/ai/providers/anthropic" }, models: {} },
    good,
  ] as never;

  assert.deepEqual(directReasoningEfforts(catalog.draft, "zz/m"), []);
  assert.equal(directModelPackage(catalog.draft, "zz/m"), "@opencode/ai/providers/openai");
  const resolved = resolveDirectModel(catalog.draft, "zz/m");
  assert.equal(resolved.candidateCount, 8);
  assert.equal(resolved.candidate?.providerID, "array-variants");
});

test("a throwing provider.list never breaks resolution", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => {
    throw new Error("catalog changed");
  };
  const resolved = resolveDirectModel(catalog.draft, "zz/m");
  assert.equal(resolved.package, PROVIDER_PACKAGE);
  assert.equal(resolved.candidateCount, 0);
  assert.deepEqual(directReasoningEfforts(catalog.draft, "zz/m"), []);
});

test("packageless duplicates fall back with one warning", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => [
    {
      provider: { id: "b" },
      models: new Map([["m", { id: "m", variants: [] }]]),
    },
    {
      provider: { id: "a" },
      models: new Map([["m", { id: "m", variants: [] }]]),
    },
  ] as never;

  const warnings: string[] = [];
  const resolved = resolveDirectModel(catalog.draft, "zz/m", {
    warn: (message) => warnings.push(message),
  });
  assert.equal(resolved.package, PROVIDER_PACKAGE);
  assert.equal(resolved.packageSource, "fallback");
  assert.equal(resolved.candidateCount, 2);
  assert.equal(resolved.candidate, undefined);
  assert.deepEqual(warnings, [
    `opencode-9router-v2: ambiguous direct-model packages for zz/m; using ${PROVIDER_PACKAGE}`,
  ]);
});

test("packageless affinity resolves through the route prefix", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => [
    {
      provider: { id: "other" },
      models: new Map([["m", { id: "m", variants: [] }]]),
    },
    {
      provider: { id: "acme" },
      models: new Map([
        ["m", { id: "m", variants: [{ id: "low", settings: { reasoningEffort: "low" } }] }],
      ]),
    },
  ] as never;

  const resolved = resolveDirectModel(catalog.draft, "acme/m");
  assert.equal(resolved.package, PROVIDER_PACKAGE);
  assert.equal(resolved.packageSource, "fallback");
  assert.equal(resolved.candidate?.providerID, "acme");
  assert.deepEqual(directReasoningEfforts(catalog.draft, "acme/m"), ["low"]);
});

test("a throwing warn sink cannot break ambiguity fallback", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => [
    {
      provider: { id: "b" },
      models: new Map([["m", { id: "m", package: "@opencode/ai/providers/anthropic", variants: [] }]]),
    },
    {
      provider: { id: "a" },
      models: new Map([["m", { id: "m", package: "@opencode/ai/providers/openai", variants: [] }]]),
    },
  ] as never;

  const resolved = resolveDirectModel(catalog.draft, "zz/m", {
    warn: () => {
      throw new Error("warn blew up");
    },
  });
  assert.equal(resolved.package, PROVIDER_PACKAGE);
  assert.equal(resolved.candidate, undefined);
});

test("records with throwing getters are skipped", () => {
  const catalog = createCatalog();
  const boom = {
    get provider(): unknown {
      throw new Error("getter blew up");
    },
    models: new Map(),
  };
  const good = {
    provider: { id: "good", package: "@opencode/ai/providers/openai" },
    models: new Map([["m", { id: "m", package: "@opencode/ai/providers/openai", variants: [] }]]),
  };
  catalog.draft.list = () => [boom, good] as never;

  const resolved = resolveDirectModel(catalog.draft, "zz/m");
  assert.equal(resolved.package, "@opencode/ai/providers/openai");
  assert.equal(resolved.candidate?.providerID, "good");
  assert.equal(resolved.candidateCount, 1);
});

test("a single packageless candidate resolves through the fallback source", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => [
    {
      provider: { id: "solo" },
      models: new Map([
        ["m", { id: "m", variants: [{ id: "low", settings: { reasoningEffort: "low" } }] }],
      ]),
    },
  ] as never;

  const resolved = resolveDirectModel(catalog.draft, "zz/m");
  assert.equal(resolved.package, PROVIDER_PACKAGE);
  assert.equal(resolved.packageSource, "fallback");
  assert.equal(resolved.candidate?.providerID, "solo");
  assert.equal(resolved.candidateCount, 1);
  assert.deepEqual(directReasoningEfforts(catalog.draft, "zz/m"), ["low"]);
  assert.equal(directTransport(catalog.draft, "zz/m"), undefined);
});

test("a non-array provider list resolves to the fallback", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => ({ length: 0 }) as never;

  const resolved = resolveDirectModel(catalog.draft, "zz/m");
  assert.equal(resolved.package, PROVIDER_PACKAGE);
  assert.equal(resolved.packageSource, "fallback");
  assert.equal(resolved.candidateCount, 0);
  assert.deepEqual(directReasoningEfforts(catalog.draft, "zz/m"), []);
});

test("conflicting packages under the same route prefix stay ambiguous", () => {
  const catalog = createCatalog();
  const warnings: string[] = [];
  catalog.draft.list = () => [
    {
      provider: { id: "acme", package: "@opencode/ai/providers/openai" },
      models: new Map([["m", { id: "m", package: "@opencode/ai/providers/openai", variants: [] }]]),
    },
    {
      provider: { id: "acme", package: "@opencode/ai/providers/anthropic" },
      models: new Map([["m", { id: "m", package: "@opencode/ai/providers/anthropic", variants: [] }]]),
    },
  ] as never;

  const resolved = resolveDirectModel(catalog.draft, "acme/m", {
    warn: (message) => warnings.push(message),
  });
  assert.equal(resolved.package, PROVIDER_PACKAGE);
  assert.equal(resolved.packageSource, "fallback");
  assert.equal(resolved.candidate, undefined);
  assert.equal(resolved.candidateCount, 2);
  assert.equal(warnings.length, 1);
});

test("a prefix-less route skips affinity and resolves deterministically", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => [
    {
      provider: { id: "b" },
      models: new Map([
        ["plain", { id: "plain", variants: [{ id: "low", settings: { reasoningEffort: "low" } }] }],
      ]),
    },
    {
      provider: { id: "a" },
      models: new Map([
        ["plain", { id: "plain", variants: [{ id: "low", settings: { reasoningEffort: "low" } }] }],
      ]),
    },
  ] as never;

  const resolved = resolveDirectModel(catalog.draft, "plain");
  assert.equal(resolved.package, PROVIDER_PACKAGE);
  assert.equal(resolved.packageSource, "fallback");
  assert.equal(resolved.candidate, undefined);
  assert.equal(resolved.candidateCount, 2);
});

test("a failing inventory write skips every staged model and reports the skip", () => {
  const catalog = createCatalog();
  const warnings: string[] = [];
  catalog.draft.models.set = () => {
    throw new Error("inventory changed");
  };

  const infos: string[] = [];
  const outcome = register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [
      { id: "bad/model", reasoning: false, thinkingCanDisable: false },
      { id: "good/model", reasoning: false, thinkingCanDisable: false },
    ],
    {
      warn: (message) => warnings.push(message),
      onResolved: (info) => infos.push(`${info.route}:${info.package}`),
    },
  );

  assert.deepEqual(outcome, { registered: 0, skipped: 2 });
  assert.deepEqual(infos, [
    `bad/model:${PROVIDER_PACKAGE}`,
    `good/model:${PROVIDER_PACKAGE}`,
  ]);
  assert.deepEqual(warnings, ["opencode-9router-v2: skipped 2 model(s) that failed to register"]);
});

test("a throwing onResolved or warn sink cannot break registration", () => {
  const catalog = createCatalog();
  const outcome = register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [{ id: "a/b", reasoning: false, thinkingCanDisable: false }],
    {
      warn: () => {
        throw new Error("warn blew up");
      },
      onResolved: () => {
        throw new Error("observer blew up");
      },
    },
  );
  assert.ok(catalog.models.get("a/b"));
  assert.deepEqual(outcome, { registered: 1, skipped: 0 });
});

test("resolves nested routes through the first segment or full prefix", () => {
  const byFirstSegment = createCatalog();
  byFirstSegment.draft.list = () => [
    {
      provider: { id: "other", package: "@opencode/ai/providers/anthropic" },
      models: new Map([
        ["c", { id: "c", package: "@opencode/ai/providers/anthropic", variants: [] }],
      ]),
    },
    {
      provider: { id: "a", package: "@opencode/ai/providers/openai" },
      models: new Map([["c", { id: "c", package: "@opencode/ai/providers/openai", variants: [] }]]),
    },
  ] as never;

  const first = resolveDirectModel(byFirstSegment.draft, "a/b/c");
  assert.equal(first.package, "@opencode/ai/providers/openai");
  assert.equal(first.packageSource, "model");
  assert.equal(first.candidate?.providerID, "a");

  const byFullPrefix = createCatalog();
  byFullPrefix.draft.list = () => [
    {
      provider: { id: "other", package: "@opencode/ai/providers/anthropic" },
      models: new Map([
        ["c", { id: "c", package: "@opencode/ai/providers/anthropic", variants: [] }],
      ]),
    },
    {
      provider: { id: "a/b", package: "@opencode/ai/providers/openai" },
      models: new Map([["c", { id: "c", package: "@opencode/ai/providers/openai", variants: [] }]]),
    },
  ] as never;

  const full = resolveDirectModel(byFullPrefix.draft, "a/b/c");
  assert.equal(full.package, "@opencode/ai/providers/openai");
  assert.equal(full.candidate?.providerID, "a/b");
});

test("warns once per ambiguous route within a registration pass", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => [
    {
      provider: { id: "b" },
      models: new Map([["m", { id: "m", package: "@opencode/ai/providers/anthropic", variants: [] }]]),
    },
    {
      provider: { id: "a" },
      models: new Map([["m", { id: "m", package: "@opencode/ai/providers/openai", variants: [] }]]),
    },
  ] as never;

  const warnings: string[] = [];
  const shared = new Set<string>();
  const options = { warn: (message: string) => warnings.push(message), warnedRoutes: shared };
  resolveDirectModel(catalog.draft, "zz/m", options);
  resolveDirectModel(catalog.draft, "zz/m", options);
  assert.deepEqual(warnings, [
    `opencode-9router-v2: ambiguous direct-model packages for zz/m; using ${PROVIDER_PACKAGE}`,
  ]);

  const passWarnings: string[] = [];
  const outcome = register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [
      { id: "zz/m", reasoning: false, thinkingCanDisable: false },
      { id: "zz/m", reasoning: false, thinkingCanDisable: false },
    ],
    { warn: (message: string) => passWarnings.push(message) },
  );
  assert.deepEqual(outcome, { registered: 2, skipped: 0 });
  assert.deepEqual(passWarnings, [
    `opencode-9router-v2: ambiguous direct-model packages for zz/m; using ${PROVIDER_PACKAGE}`,
  ]);
});

test("skips provider records with a case-variant 9router ID", () => {
  const catalog = createCatalog();
  catalog.draft.list = () => [
    {
      provider: { id: "9Router", package: "@opencode/ai/providers/anthropic" },
      models: new Map([["m", { id: "m", package: "@opencode/ai/providers/anthropic", variants: [] }]]),
    },
    {
      provider: { id: "good", package: "@opencode/ai/providers/openai" },
      models: new Map([["m", { id: "m", package: "@opencode/ai/providers/openai", variants: [] }]]),
    },
  ] as never;

  const resolved = resolveDirectModel(catalog.draft, "zz/m");
  assert.equal(resolved.package, "@opencode/ai/providers/openai");
  assert.equal(resolved.candidate?.providerID, "good");
  assert.equal(resolved.candidateCount, 1);
});

test("skips invalid discovered entries and reports counts", () => {
  const catalog = createCatalog();
  const warnings: string[] = [];
  const outcome = register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [
      null,
      { id: 42 },
      { id: "good/model", reasoning: false, thinkingCanDisable: false },
    ] as unknown as Parameters<typeof register9RouterCatalog>[2],
    { warn: (message: string) => warnings.push(message) },
  );
  assert.deepEqual(outcome, { registered: 1, skipped: 2 });
  assert.deepEqual(warnings, ["opencode-9router-v2: skipped 2 model(s) that failed to register"]);
  assert.deepEqual([...(catalog.models.keys() as unknown as string[])], ["good/model"]);
});

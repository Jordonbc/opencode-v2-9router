import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogDraft } from "../src/provider.js";
import {
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
} from "../src/provider.js";

type MutableRecord = Record<string, unknown>;

const createCatalog = () => {
  const providers = new Map<string, MutableRecord>();
  const models = new Map<string, MutableRecord>();
  const draft = {
    provider: {
      list: () => [],
      get: () => undefined,
      update: (id: string, update: (provider: MutableRecord) => void) => {
        const provider = providers.get(id) ?? { id, name: id, package: "" };
        providers.set(id, provider);
        update(provider);
      },
      remove: () => undefined,
    },
    model: {
      get: () => undefined,
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
      default: { get: () => undefined, set: () => undefined },
    },
  } as unknown as CatalogDraft;

  return { draft, models, providers };
};

const withDirectModel = (id: string, efforts: readonly string[]) => {
  const catalog = createCatalog();
  const direct = {
    provider: { id: "opencode", name: "OpenCode", package: "aisdk:@ai-sdk/openai" },
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
  catalog.draft.provider.list = () => [direct] as never;
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
      package: options.providerPackage ?? "aisdk:@ai-sdk/openai-compatible",
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
  catalog.draft.provider.list = () => [direct] as never;
  return catalog;
};

test("exposes the documented provider identity", () => {
  assert.equal(PROVIDER_ID, "9router");
  assert.equal(PROVIDER_NAME, "9Router");
  assert.equal(PROVIDER_PACKAGE, "aisdk:@ai-sdk/openai-compatible");
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
  catalog.draft.provider.list = () => [
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
  catalog.draft.provider.list = () => [
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
  catalog.draft.provider.list = () => [
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
    package: PROVIDER_PACKAGE,
    disabled: false,
    settings: {
      apiKey: "secret-key",
      baseURL: "http://10.0.0.1:20128/v1",
    },
  });
  assert.deepEqual(catalog.models.get(id), {
    id,
    modelID: id,
    name: "Muse Spark 1.3 Contributor (ocg)",
    package: "aisdk:@ai-sdk/openai",
    enabled: true,
    status: "active",
    variants: [
      { id: "minimal", settings: { reasoningEffort: "minimal" } },
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "medium", settings: { reasoningEffort: "medium" } },
      { id: "high", settings: { reasoningEffort: "high" } },
      { id: "xhigh", settings: { reasoningEffort: "xhigh" } },
    ],
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
    package: PROVIDER_PACKAGE,
    disabled: false,
    settings: {
      keep: "yes",
      apiKey: "k",
      baseURL: "http://10.0.0.1:20128/v1",
    },
  });
  assert.deepEqual(catalog.models.get("a/b"), {
    id: "a/b",
    modelID: "a/b",
    name: "B (a)",
    package: PROVIDER_PACKAGE,
    enabled: true,
    status: "active",
    variants: [],
    limit: { context: 0, output: 0 },
  });
  assert.deepEqual(catalog.models.get("plain"), {
    id: "plain",
    modelID: "plain",
    name: "Plain",
    package: PROVIDER_PACKAGE,
    enabled: true,
    status: "active",
    variants: [],
    limit: { context: 0, output: 0 },
  });
});

test("registers limits when the draft model has no limit object", () => {
  const catalog = createCatalog();
  catalog.draft.model.update = ((
    _providerID: string,
    id: string,
    update: (model: MutableRecord) => void,
  ) => {
    const model = catalog.models.get(id) ?? { id, modelID: id };
    catalog.models.set(id, model);
    update(model);
  }) as typeof catalog.draft.model.update;

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

  assert.deepEqual(catalog.models.get("c/model")?.limit, { context: 123, output: 0 });
});

test("mirrors the direct model package for Muse Spark", () => {
  const catalog = withDirectEntry({
    directID: "muse-spark-1.3-contributor",
    modelPackage: "aisdk:@ai-sdk/openai",
    providerPackage: "aisdk:@ai-sdk/openai-compatible",
  });

  assert.equal(directModelPackage(catalog.draft, "ocg/muse-spark-1.3-contributor"), "aisdk:@ai-sdk/openai");

  register9RouterCatalog(
    catalog.draft,
    { apiKey: "secret-key", baseURL: "http://10.0.0.1:20128/v1" },
    [{ id: "ocg/muse-spark-1.3-contributor", reasoning: false, thinkingCanDisable: false }],
  );

  assert.equal(catalog.models.get("ocg/muse-spark-1.3-contributor")?.package, "aisdk:@ai-sdk/openai");
});

test("mirrors an Anthropic-native direct model package", () => {
  const catalog = withDirectEntry({
    directID: "claude-sonnet-4-5",
    modelPackage: "aisdk:@ai-sdk/anthropic",
  });

  assert.equal(directModelPackage(catalog.draft, "ocg/claude-sonnet-4-5"), "aisdk:@ai-sdk/anthropic");

  register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [{ id: "ocg/claude-sonnet-4-5", reasoning: false, thinkingCanDisable: false }],
  );

  assert.equal(catalog.models.get("ocg/claude-sonnet-4-5")?.package, "aisdk:@ai-sdk/anthropic");
});

test("keeps an OpenAI-compatible direct model on the compatible transport", () => {
  const catalog = withDirectEntry({
    directID: "gpt-5-mini",
    modelPackage: "aisdk:@ai-sdk/openai-compatible",
  });

  assert.equal(
    directModelPackage(catalog.draft, "ocg/gpt-5-mini"),
    "aisdk:@ai-sdk/openai-compatible",
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
    modelPackage: "aisdk:@ai-sdk/openai",
    providerPackage: "aisdk:@ai-sdk/anthropic",
  });
  assert.equal(directModelPackage(preferred.draft, "ocg/m"), "aisdk:@ai-sdk/openai");

  const providerFallback = withDirectEntry({
    directID: "m",
    providerPackage: "aisdk:@ai-sdk/anthropic",
  });
  assert.equal(directModelPackage(providerFallback.draft, "ocg/m"), "aisdk:@ai-sdk/anthropic");
});

test("ignores 9router records when mirroring the transport package", () => {
  const catalog = createCatalog();
  catalog.draft.provider.list = () => [
    {
      provider: { id: "9router", package: "aisdk:@ai-sdk/openai-compatible" },
      models: new Map([["m", { id: "m", package: "aisdk:@ai-sdk/openai", variants: [] }]]),
    },
    {
      provider: { id: "opencode", package: "aisdk:@ai-sdk/anthropic" },
      models: new Map([["m", { id: "m", package: "aisdk:@ai-sdk/anthropic", variants: [] }]]),
    },
  ] as never;

  assert.equal(directModelPackage(catalog.draft, "ocg/m"), "aisdk:@ai-sdk/anthropic");
});

test("mirrors transport through the -review direct ID mapping", () => {
  const catalog = withDirectEntry({
    directID: "foo",
    modelPackage: "aisdk:@ai-sdk/openai",
  });

  assert.equal(directModelPackage(catalog.draft, "ocg/foo-review"), "aisdk:@ai-sdk/openai");
});

test("mirrored transport keeps the 9router baseURL and apiKey", () => {
  const catalog = withDirectEntry({
    directID: "muse-spark-1.3-contributor",
    modelPackage: "aisdk:@ai-sdk/openai",
  });
  // Simulate a direct record that also carries upstream connection settings.
  const record = (catalog.draft.provider.list() as unknown as Array<Record<string, unknown>>)[0];
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
  assert.equal(registered?.package, "aisdk:@ai-sdk/openai");
  assert.equal(registered?.modelID, "ocg/muse-spark-1.3-contributor");
  assert.deepEqual((registered as { settings?: unknown } | undefined)?.settings, undefined);
});

test("registration does not mutate the direct model", () => {
  const catalog = withDirectEntry({
    directID: "muse-spark-1.3-contributor",
    modelPackage: "aisdk:@ai-sdk/openai",
    providerPackage: "aisdk:@ai-sdk/openai",
    efforts: ["low", "medium"],
  });
  const before = JSON.stringify(catalog.draft.provider.list());

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

  assert.equal(JSON.stringify(catalog.draft.provider.list()), before);
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
    modelPackage: "aisdk:@ai-sdk/openai",
    providerPackage: "aisdk:@ai-sdk/openai-compatible",
    providerID: "opencode",
  });

  assert.deepEqual(directTransport(catalog.draft, "ocg/muse-spark-1.3-contributor"), {
    providerID: "opencode",
    modelID: "muse-spark-1.3-contributor",
    package: "aisdk:@ai-sdk/openai",
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

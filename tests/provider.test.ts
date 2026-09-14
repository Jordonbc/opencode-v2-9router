import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogDraft } from "../src/provider.js";
import {
  directModelID,
  directReasoningEfforts,
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
    package: PROVIDER_PACKAGE,
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

test("copies a partial limit without touching the other default", () => {
  const catalog = createCatalog();
  register9RouterCatalog(
    catalog.draft,
    { apiKey: "k", baseURL: "http://10.0.0.1:20128/v1" },
    [{ id: "c/model", reasoning: false, thinkingCanDisable: false, contextLimit: 123 }],
  );

  assert.deepEqual(catalog.models.get("c/model")?.limit, { context: 123, output: 0 });
});

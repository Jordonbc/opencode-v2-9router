import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError } from "../src/config.js";
import { createPlugin, PLUGIN_ID } from "../src/index.js";
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
  const providers = new Map<string, MutableRecord>();
  const models = new Map<string, MutableRecord>();
  const plugin = createPlugin({
    config: async () => ({ ok: true, value: { ...okConfig } }),
    discover: async () => [
      {
        id: "ocg/muse-spark-1.3-contributor",
        reasoning: false,
        thinkingCanDisable: false,
      },
    ],
    warn: (message) => warnings.push(message),
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
  assert.equal(providers.get(PROVIDER_ID)?.package, PROVIDER_PACKAGE);
  assert.deepEqual([...models.keys()], ["ocg/muse-spark-1.3-contributor"]);
  assert.equal(models.get("ocg/muse-spark-1.3-contributor")?.modelID, "ocg/muse-spark-1.3-contributor");
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

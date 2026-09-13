import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogDraft } from "../src/provider.js";
import {
  displayName,
  PROVIDER_PACKAGE,
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
        const model = models.get(id) ?? { id, modelID: id };
        models.set(id, model);
        update(model);
      },
      remove: () => undefined,
      default: { get: () => undefined, set: () => undefined },
    },
  } as unknown as CatalogDraft;

  return { draft, models, providers };
};

test("creates a human-friendly name without changing the route ID", () => {
  assert.equal(displayName("ocg/muse-spark-1.3-contributor"), "Muse Spark 1.3 Contributor");
});

test("registers the exact V2 provider and model transport shape", () => {
  const catalog = createCatalog();
  const id = "ocg/muse-spark-1.3-contributor";

  register9RouterCatalog(
    catalog.draft,
    { apiKey: "secret-key", baseURL: "http://10.0.0.1:20128/v1" },
    [id],
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
    name: "Muse Spark 1.3 Contributor",
    package: PROVIDER_PACKAGE,
    enabled: true,
    status: "active",
  });
});

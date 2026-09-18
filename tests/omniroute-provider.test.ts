import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@opencode/plugin";
import type { ProviderEditor } from "../src/provider.js";
import { OMNIROUTE_OPENAI_PACKAGE } from "../src/omniroute/catalog.js";
import { registerOmniRouteCatalog } from "../src/omniroute/provider.js";

type MutableRecord = Record<string, unknown>;

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
      set: (_providerID: string, infos: readonly MutableRecord[]) => {
        for (const model of infos) models.set(model.id as string, model);
      },
      update: () => undefined,
      remove: () => undefined,
    },
  } as unknown as ProviderEditor;
  return { editor, providers, models };
};

const entry = (id: string, extra: Record<string, unknown> = {}): Model.Info =>
  ({
    id,
    modelID: id,
    providerID: "omniroute",
    name: id,
    package: OMNIROUTE_OPENAI_PACKAGE,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 1000, output: 100 },
    ...extra,
  }) as unknown as Model.Info;

test("registers an independent provider with its own inventory and credentials", () => {
  const { editor, providers, models } = createEditor();
  const outcome = registerOmniRouteCatalog(
    editor,
    {
      providerID: "omniroute",
      displayName: "OmniRoute",
      apiKey: "omni-key",
      baseURL: "http://gw:20128/v1",
      models: [entry("cc/a"), entry("auto/coding")],
    },
  );
  assert.deepEqual(outcome, { registered: 2, skipped: 0 });
  assert.deepEqual(providers.get("omniroute"), {
    id: "omniroute",
    name: "OmniRoute",
    activation: "enabled",
    package: OMNIROUTE_OPENAI_PACKAGE,
    settings: { apiKey: "omni-key", baseURL: "http://gw:20128/v1" },
  });
  assert.deepEqual([...models.keys()], ["cc/a", "auto/coding"]);
  // A 9Router provider alongside is untouched.
  providers.set("9router", { id: "9router", name: "9Router" });
  assert.equal(providers.get("9router")?.name, "9Router");
});

test("updates an existing provider without dropping preserved settings", () => {
  const { editor, providers } = createEditor();
  providers.set("omniroute", {
    id: "omniroute",
    name: "old",
    package: "old",
    settings: { keep: "yes" },
  });
  registerOmniRouteCatalog(editor, {
    providerID: "omniroute",
    displayName: "OmniRoute",
    apiKey: "k",
    baseURL: "http://gw/v1",
    models: [entry("cc/a")],
  });
  assert.deepEqual(providers.get("omniroute")?.settings, {
    keep: "yes",
    apiKey: "k",
    baseURL: "http://gw/v1",
  });
});

test("honours a custom provider id and skips invalid entries", () => {
  const { editor, providers, models } = createEditor();
  const warnings: string[] = [];
  const outcome = registerOmniRouteCatalog(
    editor,
    {
      providerID: "custom-gw",
      displayName: "Custom",
      apiKey: "k",
      baseURL: "http://gw/v1",
      models: [entry("cc/a"), null, { id: 42 }] as unknown as Model.Info[],
    },
    { warn: (message) => warnings.push(message) },
  );
  assert.deepEqual(outcome, { registered: 1, skipped: 2 });
  assert.ok(providers.get("custom-gw"));
  assert.deepEqual([...models.keys()], ["cc/a"]);
  assert.deepEqual(warnings, ["opencode-9router-v2: omniroute skipped 2 model(s) that failed to register"]);
});

test("survives a failing inventory write and a throwing warn sink", () => {
  const { editor } = createEditor();
  editor.models.set = () => {
    throw new Error("inventory changed");
  };
  const outcome = registerOmniRouteCatalog(
    editor,
    {
      providerID: "omniroute",
      displayName: "OmniRoute",
      apiKey: "k",
      baseURL: "http://gw/v1",
      models: [entry("cc/a")],
    },
    {
      warn: () => {
        throw new Error("sink blew up");
      },
    },
  );
  assert.deepEqual(outcome, { registered: 0, skipped: 1 });
});

test("merges into setting-less providers and skips silently without a warn sink", () => {
  const { editor, providers, models } = createEditor();
  providers.set("omniroute", { id: "omniroute", name: "old" });
  const outcome = registerOmniRouteCatalog(editor, {
    providerID: "omniroute",
    displayName: "OmniRoute",
    apiKey: "k",
    baseURL: "http://gw/v1",
    models: [entry("cc/a"), null] as unknown as Model.Info[],
  });
  assert.deepEqual(outcome, { registered: 1, skipped: 1 });
  assert.deepEqual(providers.get("omniroute")?.settings, {
    apiKey: "k",
    baseURL: "http://gw/v1",
  });
  assert.deepEqual([...models.keys()], ["cc/a"]);
});

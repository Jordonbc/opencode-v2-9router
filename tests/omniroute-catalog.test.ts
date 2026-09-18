import assert from "node:assert/strict";
import test from "node:test";
import {
  autoComboName,
  buildCatalog,
  buildDisplayName,
  canonicalDedupSet,
  capitalizeVariant,
  compileListFilter,
  isUsableCombo,
  isUsableModelID,
  lookupEnrichment,
  buildCanonicalToAliasMap,
  mapAutoCombo,
  mapCombo,
  mapRawModel,
  OMNIROUTE_ANTHROPIC_PACKAGE,
  OMNIROUTE_OPENAI_PACKAGE,
  parseModelsPayload,
  passesComboVisibility,
  passesVisibility,
  resolveTransport,
  usableProviderSet,
  type MapContext,
} from "../src/omniroute/catalog.js";

const context = (overrides: Partial<MapContext> = {}): MapContext => ({
  providerID: "omniroute",
  format: { allowAnthropic: false, anthropicModels: [], anthropicPrefixes: [] },
  providerTag: true,
  enrichment: undefined,
  canonicalToAlias: new Map(),
  ...overrides,
});

const infoOf = (info: unknown): Record<string, unknown> => info as Record<string, unknown>;

test("parses standard and bare-array payloads while dropping malformed rows", () => {
  assert.deepEqual(
    parseModelsPayload({ data: [{ id: "cc/a" }, { id: " bad" }, null, { id: "cc/a" }] }).map(
      (entry) => entry.id,
    ),
    ["cc/a"],
  );
  assert.deepEqual(
    parseModelsPayload([{ id: "cc/a" }]).map((entry) => entry.id),
    ["cc/a"],
  );
  assert.deepEqual(parseModelsPayload({ models: [] }), []);
  assert.deepEqual(parseModelsPayload(null), []);
});

test("maps limits, modalities, tools, reasoning and release metadata", () => {
  const info = infoOf(
    mapRawModel(
      {
        id: "cc/model",
        context_length: 1000,
        max_input_tokens: 800,
        max_output_tokens: 200,
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        capabilities: { tool_calling: true, reasoning: true, effort_tiers: ["low", "high"] },
        release_date: "2026-01-02T00:00:00Z",
      },
      context(),
    ),
  );
  assert.equal(info.id, "cc/model");
  assert.equal(info.modelID, "cc/model");
  assert.equal(info.providerID, "omniroute");
  assert.equal(info.package, OMNIROUTE_OPENAI_PACKAGE);
  assert.deepEqual(info.capabilities, { tools: true, input: ["text", "image"], output: ["text"] });
  assert.deepEqual(info.limit, { context: 1000, input: 800, output: 200 });
  assert.deepEqual(info.variants, [
    { id: "low", settings: { reasoningEffort: "low" } },
    { id: "high", settings: { reasoningEffort: "high" } },
  ]);
  assert.equal((info.time as { released: number }).released, Date.parse("2026-01-02T00:00:00Z"));
  assert.deepEqual(info.cost, []);
  assert.equal(info.status, "active");
  assert.equal(info.enabled, true);
});

test("falls back to safe limits and no variants for sparse entries", () => {
  const info = infoOf(mapRawModel({ id: "plain" }, context()));
  assert.deepEqual(info.limit, { context: 200_000, output: 32_000 });
  assert.deepEqual(info.variants, []);
  assert.deepEqual(info.capabilities, { tools: false, input: ["text"], output: ["text"] });
});

test("maps vision to image input and thinking to fallback reasoning efforts", () => {
  const info = infoOf(
    mapRawModel({ id: "g/m", capabilities: { vision: true, thinking: true } }, context()),
  );
  assert.deepEqual(info.capabilities, { tools: false, input: ["text", "image"], output: ["text"] });
  assert.deepEqual((info.variants as Array<{ id: string }>).map((variant) => variant.id), [
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
});

test("ignores invalid effort tiers and unknown modalities", () => {
  const info = infoOf(
    mapRawModel(
      {
        id: "cc/m",
        capabilities: { reasoning: true, effort_tiers: ["ok", "", "bad tier!", 42, "ok"] },
        input_modalities: ["text", "smell"],
      },
      context(),
    ),
  );
  assert.deepEqual(info.variants, [{ id: "ok", settings: { reasoningEffort: "ok" } }]);
  assert.deepEqual((info.capabilities as { input: string[] }).input, ["text"]);
});

test("routes transports without ever pointing at an upstream provider", () => {
  const open = { allowAnthropic: false, anthropicModels: [] as string[], anthropicPrefixes: [] as string[] };
  assert.equal(resolveTransport("cc/x", open), OMNIROUTE_OPENAI_PACKAGE);
  assert.equal(
    resolveTransport("cc/x", { ...open, allowAnthropic: true, anthropicModels: ["cc/x"] }),
    OMNIROUTE_ANTHROPIC_PACKAGE,
  );
  assert.equal(
    resolveTransport("cc/other", { ...open, allowAnthropic: true, anthropicModels: ["cc/x"] }),
    OMNIROUTE_OPENAI_PACKAGE,
  );
  // Deprecated prefix compat still works when explicitly configured.
  assert.equal(
    resolveTransport("cc/other", { ...open, allowAnthropic: true, anthropicPrefixes: ["cc"] }),
    OMNIROUTE_ANTHROPIC_PACKAGE,
  );
  // Gateway base URLs are shared: only the package dialect changes.
  const info = infoOf(
    mapRawModel(
      { id: "cc/x" },
      context({ format: { ...open, allowAnthropic: true, anthropicModels: ["cc/x"] } }),
    ),
  );
  assert.equal(info.package, OMNIROUTE_ANTHROPIC_PACKAGE);
  assert.equal(info.modelID, "cc/x");
});

test("builds provider-tagged, free and combo display names", () => {
  assert.equal(
    buildDisplayName({
      rawID: "cc/claude-opus",
      enrichment: { name: "Claude Opus", providerAlias: "cc", providerDisplayName: "Claude" },
      providerTag: true,
    }),
    "Claude - Claude Opus",
  );
  assert.equal(
    buildDisplayName({ rawID: "cc/x", enrichment: { name: "X" }, providerTag: false }),
    "X",
  );
  assert.equal(
    buildDisplayName({
      rawID: "cc/x",
      enrichment: { name: "X Free", freeType: "recurring-monthly", monthlyTokens: 25_000_000 },
      providerTag: true,
    }),
    "[Free] X · 25M tokens/month",
  );
  assert.equal(
    buildDisplayName({
      rawID: "mix",
      enrichment: { name: "Mix", providerAlias: "antigravity", providerDisplayName: "An overlong provider label" },
      providerTag: true,
    }),
    "Antigravity - Mix",
  );
  assert.equal(
    buildDisplayName({ rawID: "Whatever", enrichment: undefined, providerTag: true }),
    "Whatever",
  );
  assert.equal(
    buildDisplayName({ rawID: "mix", enrichment: { name: "Mix" }, providerTag: true, isCombo: true }),
    "Combo: Mix",
  );
  assert.equal(autoComboName("auto", 6), "Auto: Default (6p)");
  assert.equal(autoComboName("auto/coding", 4), "Auto: Coding (4p)");
  assert.equal(autoComboName("auto/future-variant", undefined), "Auto: Future-variant");
  assert.equal(capitalizeVariant("fast"), "Fast");
});

test("aggregates combo LCD across members and honours server context", () => {
  const members = [
    {
      id: "cc/a",
      context_length: 1000,
      max_input_tokens: 800,
      max_output_tokens: 200,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      capabilities: { tool_calling: true, reasoning: true, temperature: true },
    },
    {
      id: "kr/b",
      context_length: 4000,
      max_input_tokens: 900,
      max_output_tokens: 100,
      input_modalities: ["text"],
      output_modalities: ["text"],
      capabilities: { tool_calling: true, reasoning: true },
    },
  ];
  const info = infoOf(
    mapCombo({ id: "mix", name: "Mix" }, "mix", members, context()),
  );
  assert.equal(info.id, "mix");
  assert.deepEqual(info.limit, { context: 1000, input: 800, output: 100 });
  assert.deepEqual(info.capabilities, { tools: true, input: ["text"], output: ["text"] });
  assert.match(info.name as string, /^Combo: /u);

  const server = infoOf(
    mapCombo({ id: "mix2", computed_context_length: 9000 }, "mix2", members, context()),
  );
  assert.equal((server.limit as { context: number }).context, 9000);

  const empty = infoOf(mapCombo({ id: "empty" }, "empty", [], context()));
  assert.deepEqual(empty.capabilities, {
    tools: false,
    input: [],
    output: [],
  });
  assert.deepEqual(empty.limit, { context: 200_000, output: 32_000 });
});

test("resolves nested combos, chains, hidden, cycles and collisions", () => {
  const models = [
    { id: "cc/a", context_length: 100, max_output_tokens: 10, capabilities: { tool_calling: true } },
    { id: "cc/b", context_length: 200, max_output_tokens: 20, capabilities: { tool_calling: true } },
  ];
  const base = {
    providerID: "omniroute",
    format: { allowAnthropic: false, anthropicModels: [], anthropicPrefixes: [] },
    providerTag: true,
    enrichment: undefined,
    usable: undefined,
    visible: undefined,
    hidden: undefined,
  };
  const warnings: string[] = [];

  // Basic + multiple members.
  const basic = buildCatalog(
    {
      models,
      combos: [{ id: "mix", name: "Mix", models: [{ kind: "model", model: "cc/a" }, { kind: "model", model: "cc/b" }] }],
      autoCombos: [],
    },
    { ...base, warn: (message) => warnings.push(message) },
  );
  assert.equal(basic.comboCount, 1);
  assert.equal(basic.entries.length, 3);

  // Nested combo + chain.
  const nested = buildCatalog(
    {
      models,
      combos: [
        { id: "inner", name: "Inner", models: [{ kind: "model", model: "cc/a" }] },
        {
          id: "outer",
          name: "Outer",
          models: [{ kind: "combo-ref", comboName: "Inner" }, { kind: "model", model: "cc/b" }],
        },
      ],
      autoCombos: [],
    },
    { ...base },
  );
  assert.equal(nested.comboCount, 2);
  assert.equal(nested.droppedUnresolvedCombos, 0);
  const outer = nested.entries.find((entry) => (entry as unknown as { id: string }).id === "outer");
  assert.equal((outer as unknown as { limit: { context: number } }).limit.context, 100);

  // Unresolved ref, cycle and hidden.
  const broken = buildCatalog(
    {
      models,
      combos: [
        { id: "dangling", models: [{ kind: "combo-ref", comboName: "Missing" }] },
        { id: "cyc-a", name: "A", models: [{ kind: "combo-ref", comboName: "B" }] },
        { id: "cyc-b", name: "B", models: [{ kind: "combo-ref", comboName: "A" }] },
        { id: "secret", isHidden: true, models: [{ kind: "model", model: "cc/a" }] },
      ],
      autoCombos: [],
    },
    { ...base, warn: (message) => warnings.push(message) },
  );
  assert.equal(broken.comboCount, 0);
  assert.equal(broken.droppedUnresolvedCombos, 3);
  assert.ok(warnings.some((message) => message.includes("unresolvable")));

  // Collision: combo wins with one warning.
  const collisionWarnings: string[] = [];
  const collision = buildCatalog(
    { models, combos: [{ id: "cc/a", models: [{ kind: "model", model: "cc/b" }] }], autoCombos: [] },
    { ...base, warn: (message) => collisionWarnings.push(message) },
  );
  assert.equal(collision.comboCount, 1);
  assert.equal(
    collision.entries.filter((entry) => (entry as unknown as { id: string }).id === "cc/a").length,
    1,
  );
  assert.equal(collisionWarnings.length, 1);
});

test("publishes auto combos with server limits or safe fallbacks", () => {
  const full = infoOf(
    mapAutoCombo(
      { id: "auto/coding", candidateCount: 4, context_length: 50000, max_output_tokens: 4000 },
      context(),
    ),
  );
  assert.equal(full.id, "auto/coding");
  assert.equal(full.name, "Auto: Coding (4p)");
  assert.deepEqual(full.limit, { context: 50000, output: 4000 });
  assert.deepEqual(full.capabilities, { tools: true, input: ["text"], output: ["text"] });

  const fallback = infoOf(mapAutoCombo({ id: "auto" }, context()));
  assert.equal(fallback.name, "Auto: Default");
  assert.deepEqual(fallback.limit, { context: 128_000, output: 8_192 });

  const built = buildCatalog(
    {
      models: [{ id: "cc/a" }],
      combos: [],
      autoCombos: [
        { id: "auto", candidateCount: 2 },
        { id: "auto/s forecasted", candidateCount: 1 },
        { id: "auto/hidden", isHidden: true },
      ],
    },
    {
      providerID: "omniroute",
      format: { allowAnthropic: false, anthropicModels: [], anthropicPrefixes: [] },
      providerTag: true,
      enrichment: undefined,
      usable: undefined,
      visible: undefined,
      hidden: undefined,
    },
  );
  assert.equal(built.autoComboCount, 2);
});

test("dedupes canonical twins but keeps unrelated same-suffix models", () => {
  const enrichment = new Map([
    ["cc/x", { providerAlias: "cc", providerCanonical: "claude" }],
  ]);
  const aliases = buildCanonicalToAliasMap(enrichment);
  assert.equal(aliases.get("claude"), "cc");
  assert.deepEqual(
    [...canonicalDedupSet(["cc/x", "claude/x", "kr/x"], aliases)],
    ["claude/x"],
  );
  // Alias twin absent: canonical-only model retained.
  assert.deepEqual([...canonicalDedupSet(["claude/y"], aliases)], []);
  assert.equal(lookupEnrichment("claude/x", enrichment, aliases)?.providerAlias, "cc");
  assert.equal(lookupEnrichment("cc/x", enrichment, aliases)?.providerAlias, "cc");
  assert.equal(lookupEnrichment("unknown", enrichment, aliases), undefined);
});

test("filters by usable providers subtractively", () => {
  const enrichment = new Map([
    ["cc/a", { providerAlias: "cc", providerCanonical: "claude" }],
    ["kr/b", { providerAlias: "kr", providerCanonical: "kiro" }],
  ]);
  const usable = usableProviderSet(
    [
      { id: "1", provider: "claude", isActive: true, testStatus: "active" },
      { id: "2", provider: "kiro", isActive: false },
      { id: "3", provider: "broken", testStatus: "failed" },
    ],
    enrichment,
  );
  assert.ok(usable);
  if (!usable) return;
  assert.equal(isUsableModelID("cc/a", usable), true);
  assert.equal(isUsableModelID("kr/b", usable), false);
  assert.equal(isUsableModelID("unknown/z", usable), true);
  assert.equal(isUsableModelID("bare", usable), true);
  assert.equal(isUsableModelID("cc/a", undefined), true);
  assert.equal(
    isUsableCombo(
      { id: "mix", models: [{ kind: "model", model: "kr/b" }, { kind: "model", model: "cc/a" }] },
      usable,
    ),
    true,
  );
  assert.equal(
    isUsableCombo({ id: "bad", models: [{ kind: "model", model: "kr/b" }] }, usable),
    false,
  );
  assert.equal(isUsableCombo({ id: "empty", models: [] }, usable), true);
  // Failed/empty connection lists disable filtering entirely.
  assert.equal(usableProviderSet([], enrichment), undefined);
  assert.equal(
    usableProviderSet([{ id: "1", provider: "x", isActive: false }], enrichment),
    undefined,
  );
});

test("applies visibility allowlists with deny winning", () => {
  const visible = compileListFilter(["cc/a", "suffix-only"]);
  const hidden = compileListFilter(["cc/secret"]);
  assert.equal(passesVisibility("cc/a", visible, hidden), true);
  assert.equal(passesVisibility("other/suffix-only", visible, hidden), true);
  assert.equal(passesVisibility("other/b", visible, hidden), false);
  assert.equal(passesVisibility("cc/secret", undefined, hidden), false);
  assert.equal(
    passesVisibility("cc/a", compileListFilter(["cc/a"]), compileListFilter(["cc/a"])),
    false,
  );
  assert.equal(compileListFilter([]), undefined);
  assert.equal(compileListFilter(undefined), undefined);

  const combo = { id: "mix", models: [{ kind: "model", model: "cc/a" }] };
  assert.equal(passesComboVisibility(combo, "mix", visible, undefined), true);
  assert.equal(
    passesComboVisibility(combo, "mix", compileListFilter(["other"]), undefined),
    false,
  );
  assert.equal(passesComboVisibility({ id: "mix", models: [] }, "mix", visible, undefined), true);
  assert.equal(
    passesComboVisibility(combo, "mix", undefined, compileListFilter(["cc/a"])),
    false,
  );
  assert.equal(
    passesComboVisibility({ id: "mix", models: [] }, "mix", undefined, compileListFilter(["mix"])),
    false,
  );
});

test("skips invalid rows while keeping the first duplicate", () => {
  const built = buildCatalog(
    {
      models: [null, { id: " bad" }, { id: "cc/a" }, { id: "cc/a" }, "nope", 42] as never,
      combos: [null, { id: " bad" }, { id: "mix", models: [{ kind: "model", model: "cc/a" }] }] as never,
      autoCombos: [null, { id: 7 }] as never,
    },
    {
      providerID: "omniroute",
      format: { allowAnthropic: false, anthropicModels: [], anthropicPrefixes: [] },
      providerTag: true,
      enrichment: undefined,
      usable: undefined,
      visible: undefined,
      hidden: undefined,
    },
  );
  assert.equal(built.modelCount, 1);
  assert.equal(built.comboCount, 1);
  assert.equal(built.autoComboCount, 0);
});

test("resolves combo-refs without names as unresolvable and honours odd steps", () => {
  const warnings: string[] = [];
  const built = buildCatalog(
    {
      models: [{ id: "cc/a" }],
      combos: [
        { id: "nameless", models: [{ kind: "combo-ref" }] },
        { id: "weird", models: [{ kind: "model" }, { kind: "other", model: "cc/a" }] },
      ],
      autoCombos: [],
    },
    {
      providerID: "omniroute",
      format: { allowAnthropic: false, anthropicModels: [], anthropicPrefixes: [] },
      providerTag: true,
      enrichment: undefined,
      usable: undefined,
      visible: undefined,
      hidden: undefined,
      warn: (message) => warnings.push(message),
    },
  );
  assert.equal(built.comboCount, 1);
  assert.equal(built.droppedUnresolvedCombos, 1);
});

test("filters catalogs by usable and visible rules end to end", () => {
  const enrichment = new Map([
    ["cc/a", { providerAlias: "cc", providerCanonical: "claude" }],
    ["kr/b", { providerAlias: "kr", providerCanonical: "kiro" }],
  ]);
  const usable = usableProviderSet(
    [{ id: "1", provider: "claude", isActive: true, testStatus: "active" }],
    enrichment,
  );
  const built = buildCatalog(
    {
      models: [{ id: "cc/a" }, { id: "kr/b" }, { id: "zz/c" }],
      combos: [
        { id: "good-mix", models: [{ kind: "model", model: "cc/a" }] },
        { id: "bad-mix", models: [{ kind: "model", model: "kr/b" }] },
      ],
      autoCombos: [],
    },
    {
      providerID: "omniroute",
      format: { allowAnthropic: false, anthropicModels: [], anthropicPrefixes: [] },
      providerTag: true,
      enrichment,
      usable,
      visible: compileListFilter(["cc/a", "zz/c", "good-mix"]),
      hidden: compileListFilter(["zz/c"]),
    },
  );
  const ids = built.entries.map((entry) => (entry as unknown as { id: string }).id);
  assert.deepEqual(ids, ["cc/a", "good-mix"]);
  assert.equal(usableProviderSet([null] as never, undefined), undefined);
  assert.equal(
    usableProviderSet([{ id: "e", provider: "" }], enrichment),
    undefined,
  );
  assert.equal(isUsableCombo({ id: "x" }, usable), true);
  assert.equal(
    passesComboVisibility(
      { id: "o", models: [{ kind: "combo-ref", comboName: "Inner" }] },
      "o",
      compileListFilter(["o"]),
      undefined,
    ),
    true,
  );
});

test("warns once when an auto combo collides with a model id", () => {
  const warnings: string[] = [];
  const built = buildCatalog(
    {
      models: [{ id: "cc/a" }],
      combos: [],
      autoCombos: [{ id: "cc/a", candidateCount: 2 }],
    },
    {
      providerID: "omniroute",
      format: { allowAnthropic: false, anthropicModels: [], anthropicPrefixes: [] },
      providerTag: true,
      enrichment: undefined,
      usable: undefined,
      visible: undefined,
      hidden: undefined,
      warn: (message) => warnings.push(message),
    },
  );
  assert.equal(built.autoComboCount, 1);
  assert.deepEqual(built.entries.map((entry) => (entry as unknown as { id: string }).id), ["cc/a"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] as string, /auto combo/u);
});

test("formats every free-budget flavour and provider-label shape", () => {
  const tagged = (enrichment: Parameters<typeof buildDisplayName>[0]["enrichment"], rawID = "cc/m") =>
    buildDisplayName({ rawID, enrichment, providerTag: true });
  assert.equal(
    tagged({ name: "M", providerAlias: "cc", providerDisplayName: "A very long provider name" }),
    "CC - M",
  );
  assert.equal(tagged({ name: "Y (Free)" }), "[Free] Y");
  assert.equal(
    tagged({ name: "M", freeType: "recurring-daily", monthlyTokens: 1500 }),
    "[Free] M · 1.5K tokens/day",
  );
  assert.equal(
    tagged({ name: "M", freeType: "recurring-credit", creditTokens: 999 }),
    "[Free] M · 999 credits",
  );
  assert.equal(
    tagged({ name: "M", freeType: "one-time-initial", creditTokens: 2_500_000 }),
    "[Free] M · 2.5M credits (one-time)",
  );
  assert.equal(tagged({ name: "M", freeType: "keyless" }), "[Free] M · (keyless)");
  assert.equal(tagged({ name: "M", freeType: "discontinued" }), "[Free] M · (discontinued)");
  assert.equal(tagged({ name: "M", freeType: "recurring-monthly", monthlyTokens: 999_950 }), "[Free] M · 1M tokens/month");
  assert.equal(autoComboName("custom", undefined), "Auto: custom");
  assert.equal(autoComboName("auto", 0), "Auto: Default");
});

test("falls back to default anthropic prefixes only when none are configured", () => {
  const base = { allowAnthropic: true, anthropicModels: [] as string[], anthropicPrefixes: undefined };
  assert.equal(resolveTransport("cc/m", base), OMNIROUTE_ANTHROPIC_PACKAGE);
  assert.equal(resolveTransport("zz/m", base), OMNIROUTE_OPENAI_PACKAGE);
  const empty = { ...base, anthropicPrefixes: [] as string[] };
  assert.equal(resolveTransport("cc/m", empty), OMNIROUTE_OPENAI_PACKAGE);
});

test("maps all-anthropic combos to the anthropic dialect", () => {
  const format = {
    allowAnthropic: true,
    anthropicModels: ["cc/a", "cc/b"],
    anthropicPrefixes: [] as string[],
  };
  const info = mapCombo(
    { id: "mix" },
    "mix",
    [{ id: "cc/a" }, { id: "cc/b" }],
    context({ format }),
  );
  assert.equal((info as unknown as { package: string }).package, OMNIROUTE_ANTHROPIC_PACKAGE);
});

test("applies partial pricing and validates tier spellings", () => {
  const info = mapRawModel(
    {
      id: "cc/m",
      capabilities: { effort_tiers: ["good", "x".repeat(65), "good"] },
    },
    context({
      enrichment: new Map([["cc/m", { name: "M", pricing: { input: 3 } }]]),
      canonicalToAlias: new Map(),
    }),
  );
  assert.deepEqual(info.variants, [{ id: "good", settings: { reasoningEffort: "good" } }]);
  assert.deepEqual(info.cost, [{ input: 3, output: 0, cache: { read: 0, write: 0 } }]);

  const emptyPrice = mapRawModel(
    { id: "cc/m" },
    context({ enrichment: new Map([["cc/m", { pricing: {} }]]), canonicalToAlias: new Map() }),
  );
  assert.deepEqual(emptyPrice.cost, []);

  const unknownMods = mapRawModel(
    { id: "cc/m", input_modalities: ["bogus"] },
    context(),
  );
  assert.deepEqual((unknownMods as unknown as { capabilities: unknown }).capabilities, {
    tools: false,
    input: ["text"],
    output: ["text"],
  });

  const noDate = mapRawModel({ id: "cc/m", release_date: "not-a-date" }, context());
  assert.equal((noDate as unknown as { time: { released: number } }).time.released, 0);
});

test("looks up enrichment through bare-id fallbacks", () => {
  const enrichment = new Map([["model", { name: "Bare" }]]);
  assert.equal(
    lookupEnrichment("zz/model", enrichment, new Map())?.name,
    "Bare",
  );
});

test("ignores unrecognized free types and survives throwing warn sinks", () => {
  const name = buildDisplayName({
    rawID: "cc/m",
    enrichment: { name: "M", freeType: "mystery" as never },
    providerTag: true,
  });
  assert.equal(name, "[Free] M");

  const built = buildCatalog(
    {
      models: [{ id: "cc/a" }],
      combos: [{ id: "dangling", models: [{ kind: "combo-ref", comboName: "Missing" }] }],
      autoCombos: [],
    },
    {
      providerID: "omniroute",
      format: { allowAnthropic: false, anthropicModels: [], anthropicPrefixes: [] },
      providerTag: true,
      enrichment: undefined,
      usable: undefined,
      visible: undefined,
      hidden: undefined,
      warn: () => {
        throw new Error("sink blew up");
      },
    },
  );
  assert.equal(built.comboCount, 0);
  assert.equal(built.droppedUnresolvedCombos, 1);
});

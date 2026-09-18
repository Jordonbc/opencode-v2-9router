import type { ProviderEditor } from "../provider.js";
import {
  loadOmniRouteConfig,
  type OmniRouteConfig,
  type OmniRouteLoadResult,
} from "./config.js";
import {
  fetchOmniRouteAutoCombos,
  fetchOmniRouteCombos,
  fetchOmniRouteEnrichment,
  fetchOmniRouteModels,
  fetchOmniRouteProviders,
  type ClientOptions,
} from "./client.js";
import {
  buildCatalog,
  compileListFilter,
  usableProviderSet,
  type BuiltCatalog,
  type OmniRouteEnrichmentMap,
  type OmniRouteProviderConnection,
  type OmniRouteRawAutoCombo,
  type OmniRouteRawCombo,
  type OmniRouteRawModelEntry,
} from "./catalog.js";
import {
  createOmniRouteCache,
  readSnapshot,
  snapshotContentFingerprint,
  snapshotFingerprint,
  snapshotPath,
  writeSnapshot,
  type OmniRouteCache,
  type OmniRouteSnapshot,
} from "./cache.js";
import { readConnectionKey } from "./credentials.js";
import { wrapLanguageModelForGemini, type LanguageModelLike } from "./gemini.js";
import { registerOmniRouteCatalog } from "./provider.js";

export type OmniRouteContext = {
  readonly provider: {
    readonly transform: (update: (editor: ProviderEditor) => void) => Promise<unknown>;
    readonly reload?: () => Promise<unknown>;
  };
  readonly integration?: unknown;
  readonly aisdk?: unknown;
};

export type OmniRouteFetchers = {
  readonly models: (
    baseURL: string,
    apiKey: string,
    options?: ClientOptions,
  ) => Promise<OmniRouteRawModelEntry[]>;
  readonly combos: (
    baseURL: string,
    apiKey: string,
    options?: ClientOptions,
  ) => Promise<OmniRouteRawCombo[]>;
  readonly autoCombos: (
    baseURL: string,
    apiKey: string,
    options?: ClientOptions,
  ) => Promise<OmniRouteRawAutoCombo[]>;
  readonly providers: (
    baseURL: string,
    apiKey: string,
    options?: ClientOptions,
  ) => Promise<OmniRouteProviderConnection[]>;
  readonly enrichment: (
    baseURL: string,
    apiKey: string,
    options?: ClientOptions,
  ) => Promise<OmniRouteEnrichmentMap>;
};

export type OmniRouteSetupDeps = {
  readonly config: () => Promise<OmniRouteLoadResult>;
  readonly fetchers: OmniRouteFetchers;
  readonly createCache: (ttlMs: number) => OmniRouteCache;
  readonly readSnapshot: (
    file: string,
    fingerprint: string,
  ) => Promise<OmniRouteSnapshot | undefined>;
  readonly writeSnapshot: (
    file: string,
    snapshot: OmniRouteSnapshot,
    fingerprint: string,
    warn?: (message: string) => void,
  ) => Promise<boolean>;
  readonly snapshotFile: (providerID: string) => string;
  readonly connectionKey: (
    context: unknown,
    providerID: string,
  ) => Promise<string | undefined>;
  readonly warn: (message: string) => void;
  readonly info?: (message: string) => void;
  readonly now?: () => number;
};

export const defaultOmniRouteDeps = (): OmniRouteSetupDeps => ({
  config: loadOmniRouteConfig,
  fetchers: {
    models: fetchOmniRouteModels,
    combos: fetchOmniRouteCombos,
    autoCombos: fetchOmniRouteAutoCombos,
    providers: fetchOmniRouteProviders,
    enrichment: fetchOmniRouteEnrichment,
  },
  createCache: (ttlMs) => createOmniRouteCache({ ttlMs }),
  readSnapshot,
  writeSnapshot: (file, snapshot, fingerprint, warn) =>
    writeSnapshot(file, snapshot, fingerprint, warn),
  snapshotFile: (providerID) => snapshotPath(providerID),
  connectionKey: (context, providerID) => readConnectionKey(context, providerID),
  warn: (message) => console.warn(message),
  info: (message) => console.info(message),
});

const safeWarn = (warn: ((message: string) => void) | undefined, message: string): void => {
  try {
    warn?.(message);
  } catch {
    // Observability sinks must never break fail-soft setup.
  }
};

const safeInfo = (info: ((message: string) => void) | undefined, message: string): void => {
  try {
    info?.(message);
  } catch {
    // Observability sinks must never break fail-soft setup.
  }
};

type IntegrationDraft = {
  readonly update?: (id: string, update: (info: { name?: string }) => void) => void;
  readonly method?: {
    readonly update?: (input: {
      readonly integrationID: string;
      readonly method: unknown;
    }) => void;
  };
};

const registerIntegration = (
  integration: unknown,
  config: OmniRouteConfig,
  warn: ((message: string) => void) | undefined,
): Promise<unknown> => {
  if (!integration || typeof integration !== "object") return Promise.resolve(undefined);
  const transform = (integration as { transform?: unknown }).transform;
  if (typeof transform !== "function") return Promise.resolve(undefined);
  const apply = (draft: IntegrationDraft): void => {
    try {
      draft.update?.(config.providerID, (info) => {
        info.name = config.displayName;
      });
    } catch {
      // The host may refuse edits to an integration it has not seen yet.
    }
    try {
      draft.method?.update?.({
        integrationID: config.providerID,
        method: { type: "key", label: "API key" },
      });
      draft.method?.update?.({
        integrationID: config.providerID,
        method: { type: "env", names: ["OPENCODE_OMNIROUTE_API_KEY", "OMNIROUTE_API_KEY"] },
      });
    } catch {
      // A host that refuses method registration still keeps the catalog.
    }
  };
  let registration: unknown;
  try {
    registration = (transform as (apply: (draft: IntegrationDraft) => void) => unknown)(apply);
  } catch {
    safeWarn(warn, "opencode-9router-v2: omniroute connect action unavailable; continuing");
    return Promise.resolve(undefined);
  }
  return Promise.resolve(registration).catch(() => {
    safeWarn(warn, "opencode-9router-v2: omniroute connect action unavailable; continuing");
    return undefined;
  });
};

type LanguageHookInput = {
  readonly model?: { readonly providerID?: unknown; readonly id?: unknown };
  language?: unknown;
};

const registerLanguageHook = (
  aisdk: unknown,
  providerID: string,
  warn: ((message: string) => void) | undefined,
): Promise<unknown> => {
  if (!aisdk || typeof aisdk !== "object") return Promise.resolve(undefined);
  const hook = (aisdk as { hook?: unknown }).hook;
  if (typeof hook !== "function") return Promise.resolve(undefined);
  let registration: unknown;
  try {
    registration = (
      hook as (
        name: string,
        callback: (input: LanguageHookInput) => void,
        options?: { readonly providerID?: string },
      ) => unknown
    )("language", (input) => {
      try {
        if (!input || typeof input !== "object") return;
        if (input.model?.providerID !== providerID) return;
        if (typeof input.model?.id !== "string") return;
        const wrapped = wrapLanguageModelForGemini(
          input.language as LanguageModelLike | undefined,
          input.model.id,
        );
        if (wrapped !== input.language) input.language = wrapped;
      } catch {
        // Per-request hooks must never throw.
      }
    }, { providerID });
  } catch {
    safeWarn(warn, "opencode-9router-v2: omniroute Gemini sanitization unavailable; continuing");
    return Promise.resolve(undefined);
  }
  return Promise.resolve(registration).catch(() => {
    safeWarn(warn, "opencode-9router-v2: omniroute Gemini sanitization unavailable; continuing");
    return undefined;
  });
};

type SourceOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

const fetchNetworkSnapshot = async (
  config: OmniRouteConfig,
  apiKey: string,
  managementKey: string,
  fetchers: OmniRouteFetchers,
  previous: OmniRouteSnapshot | undefined,
  onSourceError: (endpoint: string, reason: string) => void,
): Promise<{ readonly snapshot: OmniRouteSnapshot; readonly modelsFailed: boolean }> => {
  const baseURL = config.baseURL;
  let models: OmniRouteRawModelEntry[] = [];
  let modelsFailed = false;
  try {
    models = await fetchers.models(baseURL, apiKey, {
      timeoutMs: config.timeouts.models,
      onSourceError,
    });
  } catch {
    modelsFailed = true;
  }

  const combos: SourceOutcome<OmniRouteRawCombo[]> = await (async () => {
    try {
      return {
        ok: true as const,
        value: await fetchers.combos(baseURL, managementKey, {
          timeoutMs: config.timeouts.combos,
          onSourceError,
        }),
      };
    } catch {
      return { ok: false as const };
    }
  })();

  const autoCombos: SourceOutcome<OmniRouteRawAutoCombo[]> = await (async () => {
    try {
      return {
        ok: true as const,
        value: await fetchers.autoCombos(baseURL, managementKey, {
          timeoutMs: config.timeouts.autoCombos,
          onSourceError,
        }),
      };
    } catch {
      return { ok: false as const };
    }
  })();

  const providers: SourceOutcome<OmniRouteProviderConnection[]> =
    !config.usableOnly
      ? { ok: true, value: [] }
      : await (async () => {
          try {
            return {
              ok: true as const,
              value: await fetchers.providers(baseURL, managementKey, {
                timeoutMs: config.timeouts.models,
                onSourceError,
              }),
            };
          } catch {
            return { ok: false as const };
          }
        })();

  // Enrichment is optional: failures keep the previous overlay.
  let enrichment: OmniRouteEnrichmentMap | undefined;
  if (config.enrichment) {
    try {
      enrichment = await fetchers.enrichment(baseURL, managementKey, {
        timeoutMs: config.timeouts.enrichment,
        onSourceError,
      });
    } catch {
      enrichment = undefined;
    }
  } else {
    enrichment = new Map();
  }

  const previousEnrichment = previous ? new Map(previous.enrichment) : new Map();
  return {
    snapshot: {
      models,
      combos: combos.ok ? combos.value : (previous?.combos ?? []),
      autoCombos: autoCombos.ok ? autoCombos.value : (previous?.autoCombos ?? []),
      providers: providers.ok ? providers.value : (previous?.providers ?? []),
      enrichment: enrichment ? [...enrichment.entries()] : [...previousEnrichment.entries()],
      fetchedAt: Date.now(),
    },
    modelsFailed,
  };
};

const buildEntries = (
  config: OmniRouteConfig,
  snapshot: OmniRouteSnapshot,
  warn: ((message: string) => void) | undefined,
  warnedKeys: Set<string>,
): BuiltCatalog => {
  const enrichment = new Map(snapshot.enrichment);
  return buildCatalog(
    { models: snapshot.models, combos: snapshot.combos, autoCombos: snapshot.autoCombos },
    {
      providerID: config.providerID,
      format: {
        allowAnthropic: config.allowAnthropic,
        anthropicModels: config.anthropicModels,
        anthropicPrefixes: config.anthropicPrefixes,
      },
      providerTag: config.providerTag,
      enrichment,
      usable: usableProviderSet(snapshot.providers, enrichment),
      visible: compileListFilter(config.visibleModels),
      hidden: compileListFilter(config.hiddenModels),
      warn,
      warnedKeys,
    },
  );
};

export type PartialOmniRouteSetupDeps = {
  readonly [K in keyof OmniRouteSetupDeps]?: OmniRouteSetupDeps[K];
};

export const setupOmniRoute = async (
  context: OmniRouteContext,
  overrides: PartialOmniRouteSetupDeps = {},
): Promise<void> => {
  const defaults = defaultOmniRouteDeps();
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) cleaned[key] = value;
  }
  const deps: OmniRouteSetupDeps = { ...defaults, ...(cleaned as PartialOmniRouteSetupDeps) } as OmniRouteSetupDeps;
  const warn = (message: string): void => safeWarn(deps.warn, message);
  const info = (message: string): void => safeInfo(deps.info, message);
  const now = deps.now ?? Date.now;

  let loaded: OmniRouteLoadResult;
  try {
    loaded = await deps.config();
  } catch {
    warn("opencode-9router-v2: invalid omniroute configuration");
    return;
  }
  if (!loaded.ok) {
    warn(`opencode-9router-v2: ${loaded.error.message}`);
    return;
  }
  const config = loaded.value;
  if (!config) return;

  await registerIntegration(context.integration, config, deps.warn);

  let stored: string | undefined;
  try {
    stored = await deps.connectionKey(context, config.providerID);
  } catch {
    stored = undefined;
  }
  const apiKey = stored && stored.length > 0 ? stored : config.apiKey;
  const managementKey =
    config.managementKey && config.managementKey.length > 0 ? config.managementKey : apiKey;
  if (!apiKey) {
    warn("opencode-9router-v2: omniroute API key is not configured");
    return;
  }

  const warnedEndpoints = new Set<string>();
  const onSourceError = (endpoint: string, reason: string): void => {
    if (warnedEndpoints.has(endpoint)) return;
    warnedEndpoints.add(endpoint);
    warn(`opencode-9router-v2: omniroute ${endpoint} unavailable (${reason}); continuing degraded`);
  };

  const fingerprint = snapshotFingerprint(config.gatewayRoot, apiKey, managementKey);
  const cache = deps.createCache(config.cacheTtlMs);
  let file: string | undefined;
  try {
    file = deps.snapshotFile(config.providerID);
  } catch {
    file = undefined;
  }

  const fresh = cache.fresh(fingerprint);
  let previous = cache.lastKnownGood(fingerprint);
  if (!previous && file) {
    try {
      const disk = await deps.readSnapshot(file, fingerprint);
      if (disk && disk.models.length > 0) {
        cache.store(fingerprint, disk);
        previous = disk;
      }
    } catch {
      // A bad cache file must never prevent startup.
    }
  }

  if (fresh) {
    previous = fresh;
  }

  let snapshot: OmniRouteSnapshot | undefined;
  let servedStale = false;
  if (fresh) {
    snapshot = fresh;
  } else if (cache.coolingDown(fingerprint) && previous) {
    snapshot = previous;
    servedStale = true;
  } else {
    let outcome:
      | { readonly snapshot: OmniRouteSnapshot; readonly modelsFailed: boolean }
      | undefined;
    try {
      outcome = await cache.refresh(fingerprint, async () => {
        const fetched = await fetchNetworkSnapshot(
          config,
          apiKey,
          managementKey,
          deps.fetchers,
          previous,
          onSourceError,
        );
        return { snapshot: fetched.snapshot, modelsFailed: fetched.modelsFailed };
      });
    } catch {
      outcome = undefined;
    }
    if (outcome && outcome.snapshot.models.length > 0) {
      snapshot = { ...outcome.snapshot, fetchedAt: now() };
      cache.store(fingerprint, snapshot);
      if (file) {
        try {
          await deps.writeSnapshot(file, snapshot, fingerprint, deps.warn);
        } catch {
          // Disk failures continue with memory/network state.
        }
      }
    } else {
      // The fetch ran and proved nothing routable (or the cache itself
      // broke): cool down, then fail closed to last-known-good.
      if (outcome) cache.noteEmptyModels(fingerprint);
      if (previous && previous.models.length > 0) {
        snapshot = previous;
        servedStale = true;
        warn("opencode-9router-v2: omniroute gateway unreachable; serving last-known-good catalog");
      } else {
        warn("opencode-9router-v2: omniroute model discovery failed; OmniRoute will be unavailable");
        return;
      }
    }
  }

  const warnedKeys = new Set<string>();
  const built = buildEntries(config, snapshot, deps.warn, warnedKeys);
  if (built.entries.length === 0) {
    warn("opencode-9router-v2: omniroute returned no usable models");
    return;
  }

  const cell: { snapshot: OmniRouteSnapshot; built: BuiltCatalog } = { snapshot, built };
  try {
    await context.provider.transform((editor) => {
      registerOmniRouteCatalog(
        editor,
        {
          providerID: config.providerID,
          displayName: config.displayName,
          apiKey,
          baseURL: config.baseURL,
          models: cell.built.entries,
        },
        { warn: deps.warn },
      );
    });
  } catch {
    warn("opencode-9router-v2: failed to register OmniRoute models; continuing without them");
    return;
  }

  info(
    `opencode-9router-v2: registered ${built.modelCount} model(s) from OmniRoute ` +
      `(${built.comboCount} combo(s), ${built.autoComboCount} auto combo(s))`,
  );

  if (config.geminiSanitization) {
    await registerLanguageHook(context.aisdk, config.providerID, deps.warn);
  }

  // Stale snapshot served: one background refresh, then a single reload only
  // when the content actually changed. No loops, no storms.
  if (servedStale) {
    try {
      const outcome = await fetchNetworkSnapshot(
        config,
        apiKey,
        managementKey,
        deps.fetchers,
        cell.snapshot,
        onSourceError,
      );
      if (outcome.snapshot.models.length === 0 || outcome.modelsFailed) return;
      const upgraded: OmniRouteSnapshot = { ...outcome.snapshot, fetchedAt: now() };
      const before = snapshotContentFingerprint(cell.snapshot);
      const after = snapshotContentFingerprint(upgraded);
      if (before === after) return;
      cache.store(fingerprint, upgraded);
      if (file) {
        try {
          await deps.writeSnapshot(file, upgraded, fingerprint, deps.warn);
        } catch {
          // Disk failures continue with memory/network state.
        }
      }
      cell.snapshot = upgraded;
      cell.built = buildEntries(config, upgraded, deps.warn, warnedKeys);
      if (typeof context.provider.reload === "function") {
        try {
          await context.provider.reload();
        } catch {
          warn("opencode-9router-v2: omniroute catalog reload failed; keeping current catalog");
        }
      }
    } catch {
      // Background refreshes must never break the published catalog.
    }
  }
};

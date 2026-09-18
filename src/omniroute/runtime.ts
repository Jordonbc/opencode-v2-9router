import type { ProviderEditor } from "../provider.js";
import { loadOmniRouteConfig, type OmniRouteConfig } from "./config.js";
import {
  DEFAULT_MODEL_CACHE_TTL_MS,
  UNREACHABLE_COOLDOWN_MS,
  memoryCacheKey,
  readDiskSnapshot,
  snapshotIdentityFingerprint,
  writeDiskSnapshot,
  type CatalogSnapshot,
} from "./upstream/cache.js";
import { publishCatalog, type ResolvedOptions } from "./upstream/catalog.js";
import { sanitizeToolSchemasFor } from "./upstream/gemini-language.js";
import {
  createLogger,
  defaultOmniRouteAutoCombosFetcher,
  defaultOmniRouteCombosFetcher,
  defaultOmniRouteEnrichmentFetcher,
  defaultOmniRouteModelsFetcher,
  defaultOmniRouteProvidersFetcher,
  ensureV1Suffix,
  optionalTierFingerprint,
  catalogContentFingerprint,
  type Logger,
} from "./upstream/shared/index.js";

type AnyContext = Record<string, any>;

type CacheState = {
  entries: Map<string, CatalogSnapshot>;
  inFlight: Map<string, Promise<CatalogSnapshot>>;
  unreachableUntil: number;
  warmFor?: string;
  fingerprint?: string;
  optionalFingerprint?: string;
};

const stateByProvider = new Map<string, CacheState>();

const stateFor = (providerId: string): CacheState => {
  let state = stateByProvider.get(providerId);
  if (!state) {
    state = {
      entries: new Map(),
      inFlight: new Map(),
      unreachableUntil: 0,
    };
    stateByProvider.set(providerId, state);
  }
  return state;
};

const readStoredKey = async (
  ctx: AnyContext,
  integrationID: string,
  log: Logger,
): Promise<string | undefined> => {
  const connection = ctx.integration?.connection;
  if (!connection || typeof connection.active !== "function" || typeof connection.resolve !== "function") {
    return undefined;
  }
  try {
    const active = await connection.active(integrationID);
    if (active === undefined) return undefined;
    const credential = await connection.resolve(active);
    if (credential?.type !== "key") return undefined;
    return typeof credential.key === "string" && credential.key.length > 0 ? credential.key : undefined;
  } catch (error) {
    log.warn(
      `[omniroute-v2] could not read the stored credential: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
};

const resolveKey = async (
  ctx: AnyContext,
  cfg: OmniRouteConfig,
  log: Logger,
): Promise<string> => {
  const stored = await readStoredKey(ctx, cfg.providerId, log);
  const key = stored || cfg.apiKey || "";
  if (!key) {
    log.warn(
      `[omniroute-v2] no API key for "${cfg.providerId}": connect the integration or set OPENCODE_OMNIROUTE_API_KEY`,
    );
  }
  return key;
};

const registerIntegration = async (ctx: AnyContext, cfg: OmniRouteConfig, log: Logger): Promise<void> => {
  const transform = ctx.integration?.transform;
  if (typeof transform !== "function") return;
  try {
    await transform((draft: any) => {
      try {
        draft.update(cfg.providerId, (integration: any) => {
          integration.name = cfg.displayName;
        });
        draft.method?.update?.({
          integrationID: cfg.providerId,
          method: { type: "key", label: "API key" },
        });
        draft.method?.update?.({
          integrationID: cfg.providerId,
          method: {
            type: "env",
            names: ["OPENCODE_OMNIROUTE_API_KEY", "OMNIROUTE_API_KEY"],
          },
        });
      } catch (error) {
        log.warn(
          `[omniroute-v2] integration registration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  } catch (error) {
    log.warn(
      `[omniroute-v2] host refused the integration hook: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const registerGeminiSanitizer = async (
  ctx: AnyContext,
  cfg: OmniRouteConfig,
  log: Logger,
): Promise<void> => {
  if (!cfg.geminiSanitization) return;
  const language = ctx.aisdk?.language;
  if (typeof language !== "function") return;
  try {
    await language((input: any) => {
      if (input?.model?.providerID !== cfg.providerId) return;
      input.language = sanitizeToolSchemasFor(input.language, input.model.id, log);
    });
  } catch (error) {
    log.warn(
      `[omniroute-v2] language-model hook registration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const fetchSnapshot = async (
  cfg: OmniRouteConfig,
  apiKey: string,
  managementKey: string,
  log: Logger,
): Promise<CatalogSnapshot> => {
  const fetchedAt = Date.now();
  const models = await defaultOmniRouteModelsFetcher(cfg.baseURL, apiKey, cfg.timeouts.models);

  const source = async <T>(name: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      log.warn(
        `[omniroute-v2] ${name} fetch failed; keeping degraded catalog: ${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    }
  };

  const [combos, autoCombos, providers, enrichment] = await Promise.all([
    source("combos", [], () =>
      defaultOmniRouteCombosFetcher(cfg.baseURL, managementKey, cfg.timeouts.combos),
    ),
    source("auto combos", [], () =>
      defaultOmniRouteAutoCombosFetcher(cfg.baseURL, managementKey, cfg.timeouts.autoCombos),
    ),
    cfg.usableOnly
      ? source("providers", [], () =>
          defaultOmniRouteProvidersFetcher(cfg.baseURL, managementKey, cfg.timeouts.models),
        )
      : Promise.resolve([]),
    cfg.enrichment
      ? source("enrichment", new Map(), () =>
          defaultOmniRouteEnrichmentFetcher(
            cfg.baseURL,
            managementKey,
            cfg.timeouts.enrichment,
          ),
        )
      : Promise.resolve(new Map()),
  ]);

  return { models, combos, autoCombos, providers, enrichment, fetchedAt };
};

const ensureProvider = (editor: ProviderEditor, cfg: OmniRouteConfig, apiKey: string): void => {
  if (editor.get(cfg.providerId) !== undefined) return;
  editor.add({
    info: {
      id: cfg.providerId,
      name: cfg.displayName,
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: ensureV1Suffix(cfg.baseURL), apiKey },
    } as never,
    models: [],
  });
};

const publishIntoStableEditor = async (
  editor: ProviderEditor,
  cfg: OmniRouteConfig,
  apiKey: string,
  managementKey: string,
  snapshot: CatalogSnapshot,
  log: Logger,
): Promise<{ models: number; combos: number; autoCombos: number }> => {
  ensureProvider(editor, cfg, apiKey);

  const staged = new Map<string, Record<string, unknown>>();
  const draft = {
    provider: {
      list: () => editor.list(),
      get: (id: string) => editor.get(id),
      update: (id: string, update: (provider: any) => void) => {
        ensureProvider(editor, cfg, apiKey);
        editor.update(id, (provider: any) => {
          update(provider);
          provider.settings = {
            ...(provider.settings ?? {}),
            apiKey,
            baseURL: provider.settings?.baseURL ?? ensureV1Suffix(cfg.baseURL),
          };
        });
      },
      remove: (id: string) => editor.remove(id),
    },
    model: {
      get: (_providerID: string, modelID: string) => staged.get(modelID),
      update: (providerID: string, modelID: string, update: (model: any) => void) => {
        const model = staged.get(modelID) ?? {
          id: modelID,
          modelID,
          providerID,
          name: modelID,
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 0, output: 0 },
          settings: {},
          headers: {},
        };
        update(model);
        model.modelID = modelID;
        model.providerID = providerID;
        model.settings = {
          ...(model.settings as Record<string, unknown> ?? {}),
          apiKey,
          baseURL:
            (model.settings as Record<string, unknown> | undefined)?.baseURL ??
            ensureV1Suffix(cfg.baseURL),
        };
        staged.set(modelID, model);
      },
      remove: (_providerID: string, modelID: string) => staged.delete(modelID),
      default: { get: () => undefined, set: () => undefined },
    },
  };

  const options: ResolvedOptions = {
    providerId: cfg.providerId,
    baseURL: cfg.baseURL,
    apiKey,
    managementReadToken: managementKey,
    timeoutMs: cfg.timeoutMs,
    timeouts: cfg.timeouts,
    modelCacheTtlMs: cfg.modelCacheTtlMs || DEFAULT_MODEL_CACHE_TTL_MS,
    providerTag: cfg.providerTag,
    displayName: cfg.displayName,
    apiFormat: cfg.apiFormat,
    visibleModels: cfg.visibleModels,
    hiddenModels: cfg.hiddenModels,
    usableOnly: cfg.usableOnly,
    enrichment: cfg.enrichment,
    logger: log,
    logLevel: cfg.logLevel,
    startupDebug: cfg.startupDebug,
  };

  const counts = await publishCatalog(draft as never, options, {
    models: async () => snapshot.models,
    combos: async () => snapshot.combos,
    autoCombos: async () => snapshot.autoCombos,
    providers: async () => snapshot.providers ?? [],
    enrichment: async () => snapshot.enrichment ?? new Map(),
  });

  editor.models.set(cfg.providerId, [...staged.values()] as never);
  return counts;
};

export const setupOmniRoute = async (ctx: AnyContext): Promise<void> => {
  const cfg = loadOmniRouteConfig();
  if (!cfg) return;

  const log = createLogger(cfg.startupDebug ? "debug" : (cfg.logLevel ?? "warn"));
  await registerIntegration(ctx, cfg, log);
  await registerGeminiSanitizer(ctx, cfg, log);

  const providerTransform = ctx.provider?.transform;
  if (typeof providerTransform !== "function") {
    log.warn("[omniroute-v2] host has no provider.transform; OmniRoute is unavailable");
    return;
  }

  const state = stateFor(cfg.providerId);

  await providerTransform(async (editor: ProviderEditor) => {
    const apiKey = await resolveKey(ctx, cfg, log);
    if (!apiKey) return;
    const managementKey = cfg.managementReadToken || apiKey;
    if (!cfg.managementReadToken) {
      log.warn(
        "[omniroute-v2] management token not configured; falling back to inference API key for /api/* endpoints",
      );
    }

    const identity = snapshotIdentityFingerprint(cfg.baseURL, apiKey, managementKey);
    const cacheKey = memoryCacheKey(cfg.baseURL, identity);

    if (state.warmFor !== identity) {
      state.warmFor = identity;
      const warm = await readDiskSnapshot(cfg.providerId, identity, log);
      if (warm && !state.entries.has(cacheKey)) state.entries.set(cacheKey, warm);
    }

    const now = Date.now();
    let snapshot = state.entries.get(cacheKey);
    if (!snapshot || snapshot.fetchedAt + cfg.modelCacheTtlMs <= now) {
      if (!(snapshot && now < state.unreachableUntil)) {
        let inflight = state.inFlight.get(cacheKey);
        if (!inflight) {
          inflight = fetchSnapshot(cfg, apiKey, managementKey, log);
          state.inFlight.set(cacheKey, inflight);
          inflight.finally(() => {
            if (state.inFlight.get(cacheKey) === inflight) state.inFlight.delete(cacheKey);
          }).catch(() => undefined);
        }
        try {
          const fresh = await inflight;
          if (fresh.models.length > 0) {
            snapshot = fresh;
            state.entries.set(cacheKey, fresh);
            state.unreachableUntil = 0;
            await writeDiskSnapshot(cfg.providerId, fresh, identity, log);
          } else {
            state.unreachableUntil = Date.now() + UNREACHABLE_COOLDOWN_MS;
          }
        } catch (error) {
          state.unreachableUntil = Date.now() + UNREACHABLE_COOLDOWN_MS;
          log.warn(
            `[omniroute-v2] models fetch failed, keeping last-known catalog: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    snapshot ??= state.entries.get(cacheKey);
    if (!snapshot || snapshot.models.length === 0) {
      log.warn("[omniroute-v2] no usable model catalog is available");
      return;
    }

    const counts = await publishIntoStableEditor(
      editor,
      cfg,
      apiKey,
      managementKey,
      snapshot,
      log,
    );

    const fingerprint = catalogContentFingerprint(
      snapshot.models,
      snapshot.combos,
      snapshot.autoCombos,
    );
    const optionalFingerprint = optionalTierFingerprint(
      snapshot.autoCombos,
      snapshot.providers ?? [],
      snapshot.enrichment,
      snapshot.combos,
    );
    state.fingerprint = fingerprint;
    state.optionalFingerprint = optionalFingerprint;

    log.info(
      `[omniroute-v2] registered ${counts.models} model(s), ${counts.combos} combo(s), ${counts.autoCombos} auto-combo(s)`,
    );
  });
};

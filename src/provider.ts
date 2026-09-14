import type { Plugin } from "@opencode-ai/plugin";
import type { RouterConfig } from "./config.js";
import type { DiscoveredModel } from "./discovery.js";

export const PROVIDER_ID = "9router";
export const PROVIDER_NAME = "9Router";
export const PROVIDER_PACKAGE = "aisdk:@ai-sdk/openai-compatible";

/** Route used for temporary transport observability. Contains no credentials. */
export const MUSE_DEBUG_ROUTE = "ocg/muse-spark-1.3-contributor";

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
const FALLBACK_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export type CatalogDraft = Parameters<
  Parameters<Plugin.Context["catalog"]["transform"]>[0]
>[0];

export const displayName = (modelID: string): string => {
  const separator = modelID.lastIndexOf("/");
  const routeName = separator < 0 ? modelID : modelID.slice(separator + 1);
  const prefix = separator <= 0 ? "" : modelID.slice(0, separator);
  const base = routeName
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => {
      if (/^[a-z]{1,3}$/u.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
  if (!prefix) return base;
  if (!base) return `(${prefix})`;
  return `${base} (${prefix})`;
};

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === "string" && REASONING_EFFORTS.some((effort) => effort === value);

export const directModelID = (routeID: string): string =>
  routeID.slice(routeID.lastIndexOf("/") + 1).replace(/-review$/u, "");

export type DirectCandidate = {
  /** ID of the non-9router provider record that supplied the match. */
  readonly providerID: string;
  /** ID of the direct model within that provider record. */
  readonly modelID: string;
  /** Package declared on the direct model itself, when present. */
  readonly modelPackage?: string;
  /** Package declared on the direct model's provider record, when present. */
  readonly providerPackage?: string;
  /** Reasoning efforts mirrored from the direct model. */
  readonly efforts: readonly ReasoningEffort[];
};

export type PackageSource = "model" | "provider" | "fallback";

export type ResolvedDirectModel = {
  /** The single selected candidate. Absent when nothing matched or on conflict. */
  readonly candidate?: DirectCandidate;
  /** Effective transport package (conservative fallback when unresolved). */
  readonly package: string;
  /** Where the effective package came from. */
  readonly packageSource: PackageSource;
  /** How many non-9router candidates matched the direct model ID. */
  readonly candidateCount: number;
};

export type DirectTransport = {
  /** ID of the non-9router provider record that supplied the match. */
  readonly providerID: string;
  /** ID of the direct model within that provider record. */
  readonly modelID: string;
  /** Transport package mirrored from the direct model (or its provider). */
  readonly package: string;
};

export type ResolutionInfo = {
  /** Discovered 9Router route being registered. */
  readonly route: string;
  /** Selected direct provider ID. Absent when nothing matched or on conflict. */
  readonly providerID?: string;
  /** Direct model ID the route resolved to. */
  readonly modelID: string;
  /** Effective transport package for the route. */
  readonly package: string;
  /** Where the effective package came from. */
  readonly packageSource: PackageSource;
  /** How many non-9router candidates matched. */
  readonly candidateCount: number;
};

export type ResolveOptions = {
  readonly warn?: (message: string) => void;
  /**
   * Routes already warned about during this registration pass. Lets repeated
   * resolutions of the same ambiguous route (and transform replays) warn once.
   */
  readonly warnedRoutes?: Set<string>;
};

export type RegisterOptions = {
  readonly warn?: (message: string) => void;
  readonly warnedRoutes?: Set<string>;
  readonly onResolved?: (info: ResolutionInfo) => void;
};

const safeWarn = (warn: ((message: string) => void) | undefined, message: string): void => {
  try {
    warn?.(message);
  } catch {
    // Observability sinks must never break catalog registration.
  }
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const candidateEfforts = (direct: { variants?: unknown }): ReasoningEffort[] => {
  const { variants } = direct;
  if (!Array.isArray(variants)) return [];
  const seen = new Set<ReasoningEffort>();
  for (const variant of variants) {
    if (!variant || typeof variant !== "object") continue;
    const { settings } = variant as { settings?: unknown };
    if (!settings || typeof settings !== "object") continue;
    const { reasoningEffort: effort } = settings as { reasoningEffort?: unknown };
    if (isReasoningEffort(effort)) seen.add(effort);
  }
  return [...seen];
};

const collectCandidates = (catalog: CatalogDraft, modelID: string): DirectCandidate[] => {
  const candidates: DirectCandidate[] = [];

  let records: readonly unknown[];
  try {
    records = catalog.provider.list() as unknown as readonly unknown[];
  } catch {
    return candidates;
  }
  if (!Array.isArray(records)) return candidates;

  for (const record of records) {
    try {
      if (!record || typeof record !== "object") continue;
      const { provider, models } = record as { provider?: unknown; models?: unknown };
      if (
        !provider ||
        typeof provider !== "object" ||
        !models ||
        typeof models !== "object"
      ) {
        continue;
      }
      const providerRecord = provider as { id?: unknown; package?: unknown };
      const providerID = providerRecord.id;
      if (typeof providerID !== "string" || providerID.toLowerCase() === PROVIDER_ID) continue;
      const get = (models as { get?: unknown }).get;
      if (typeof get !== "function") continue;
      const direct = (get as (id: string) => unknown).call(models, modelID);
      if (!direct || typeof direct !== "object") continue;
      const directRecord = direct as { package?: unknown; variants?: unknown };
      const modelPackage = nonEmptyString(directRecord.package);
      const providerPackage = nonEmptyString(providerRecord.package);
      candidates.push({
        providerID,
        modelID,
        modelPackage,
        providerPackage,
        efforts: candidateEfforts(directRecord),
      });
    } catch {
      continue;
    }
  }
  return candidates;
};

const byProviderID = (a: DirectCandidate, b: DirectCandidate): number =>
  a.providerID < b.providerID ? -1 : a.providerID > b.providerID ? 1 : 0;

/**
 * Split a route into its provider hint (first segment) and full prefix (all
 * segments but the last, which directModelID resolves). Affinity matches a
 * candidate when the provider ID equals either form, so nested routes such
 * as `a/b/c` (model `c`) can still match owning provider `a`.
 */
const splitRoute = (routeID: string): { fullPrefix: string; providerHint: string } => {
  const firstSlash = routeID.indexOf("/");
  const lastSlash = routeID.lastIndexOf("/");
  return {
    fullPrefix: lastSlash > 0 ? routeID.slice(0, lastSlash) : "",
    providerHint: firstSlash > 0 ? routeID.slice(0, firstSlash) : "",
  };
};

const matchesAffinity = (
  candidate: DirectCandidate,
  route: { fullPrefix: string; providerHint: string },
): boolean =>
  candidate.providerID === route.fullPrefix ||
  (route.providerHint !== "" && candidate.providerID === route.providerHint);

const ambiguousFallback = (
  candidateCount: number,
  routeID: string,
  warn: ((message: string) => void) | undefined,
  warnedRoutes?: Set<string>,
): ResolvedDirectModel => {
  if (warnedRoutes === undefined) {
    safeWarn(
      warn,
      `opencode-9router-v2: ambiguous direct-model packages for ${routeID}; using ${PROVIDER_PACKAGE}`,
    );
  } else if (!warnedRoutes.has(routeID)) {
    warnedRoutes.add(routeID);
    safeWarn(
      warn,
      `opencode-9router-v2: ambiguous direct-model packages for ${routeID}; using ${PROVIDER_PACKAGE}`,
    );
  }
  return { package: PROVIDER_PACKAGE, packageSource: "fallback", candidateCount };
};

const resolvePackageless = (
  candidates: readonly DirectCandidate[],
  routeID: string,
  warn: ((message: string) => void) | undefined,
  warnedRoutes?: Set<string>,
): ResolvedDirectModel => {
  if (candidates.length === 0) {
    return { package: PROVIDER_PACKAGE, packageSource: "fallback", candidateCount: 0 };
  }
  const sorted = [...candidates].sort(byProviderID);
  const affinityMatches = sorted.filter((candidate) =>
    matchesAffinity(candidate, splitRoute(routeID)),
  );
  let affinityChoice: DirectCandidate | undefined;
  if (affinityMatches.length === 1) {
    affinityChoice = affinityMatches[0];
  } else if (sorted.length === 1) {
    affinityChoice = sorted[0];
  }
  if (affinityChoice === undefined) {
    return ambiguousFallback(candidates.length, routeID, warn, warnedRoutes);
  }
  return {
    candidate: affinityChoice,
    package: PROVIDER_PACKAGE,
    packageSource: "fallback",
    candidateCount: candidates.length,
  };
};

/**
 * Resolve the single direct-model candidate for a route. Collects every
 * matching non-9router candidate, prefers model-level package metadata over
 * provider-level fallback, and never depends on provider.list() ordering.
 * Conflicting packages fall back to the conservative compatible transport
 * unless the route names the owning provider (e.g. `acme/model` matching
 * provider `acme`, or nested `a/b/c` matching provider `a` or `a/b`).
 */
export const resolveDirectModel = (
  catalog: CatalogDraft,
  routeID: string,
  options: ResolveOptions = {},
): ResolvedDirectModel => {
  const modelID = directModelID(routeID);
  const candidates = collectCandidates(catalog, modelID);

  const withModelPackage = candidates.filter(
    (candidate) => candidate.modelPackage !== undefined,
  );
  const useModelLevel = withModelPackage.length > 0;
  const pool = useModelLevel
    ? withModelPackage
    : candidates.filter((candidate) => candidate.providerPackage !== undefined);
  const source: "model" | "provider" = useModelLevel ? "model" : "provider";

  if (pool.length === 0) {
    return resolvePackageless(candidates, routeID, options.warn, options.warnedRoutes);
  }

  const poolPackage = (candidate: DirectCandidate): string =>
    (source === "model" ? candidate.modelPackage : candidate.providerPackage) as string;
  const distinct = [...new Set(pool.map(poolPackage))];
  const ordered = [...pool].sort(byProviderID);

  if (distinct.length === 1) {
    const candidate = ordered[0] as DirectCandidate;
    return {
      candidate,
      package: distinct[0] as string,
      packageSource: source,
      candidateCount: candidates.length,
    };
  }

  const route = splitRoute(routeID);
  const affinity = ordered.filter((candidate) => matchesAffinity(candidate, route));
  const affinityPackages = [...new Set(affinity.map(poolPackage))];
  let affinityChoice: DirectCandidate | undefined;
  if (affinity.length > 0 && affinityPackages.length === 1) {
    affinityChoice = affinity[0];
  }
  if (affinityChoice !== undefined) {
    return {
      candidate: affinityChoice,
      package: affinityPackages[0] as string,
      packageSource: source,
      candidateCount: candidates.length,
    };
  }

  return ambiguousFallback(candidates.length, routeID, options.warn, options.warnedRoutes);
};

export const directTransport = (
  catalog: CatalogDraft,
  routeID: string,
): DirectTransport | undefined => {
  const resolved = resolveDirectModel(catalog, routeID);
  if (resolved.candidate === undefined || resolved.packageSource === "fallback") return undefined;
  return {
    providerID: resolved.candidate.providerID,
    modelID: resolved.candidate.modelID,
    package: resolved.package,
  };
};

export const directModelPackage = (catalog: CatalogDraft, routeID: string): string =>
  directTransport(catalog, routeID)?.package ?? PROVIDER_PACKAGE;

export const directReasoningEfforts = (
  catalog: CatalogDraft,
  routeID: string,
): ReasoningEffort[] => [...(resolveDirectModel(catalog, routeID).candidate?.efforts ?? [])];

const selectEfforts = (
  candidateEfforts: readonly ReasoningEffort[],
  model: Pick<DiscoveredModel, "reasoning" | "thinkingCanDisable">,
): ReasoningEffort[] => {
  if (!model.reasoning) return [];
  const direct = candidateEfforts.filter(
    (effort) => effort !== "none" || model.thinkingCanDisable,
  );
  if (direct.length > 0) return [...direct];
  if (!model.thinkingCanDisable) return [...FALLBACK_REASONING_EFFORTS];
  return ["none", ...FALLBACK_REASONING_EFFORTS];
};

export const reasoningVariants = (
  catalog: CatalogDraft,
  model: Pick<DiscoveredModel, "id" | "reasoning" | "thinkingCanDisable">,
): Array<{ id: string; settings: { reasoningEffort: string } }> => {
  const efforts = selectEfforts(
    resolveDirectModel(catalog, model.id).candidate?.efforts ?? [],
    model,
  );
  return efforts.map((effort) => ({ id: effort, settings: { reasoningEffort: effort } }));
};

export type RegisterResult = {
  /** Models successfully written to the catalog. */
  readonly registered: number;
  /** Discovered entries skipped because preparation or update failed. */
  readonly skipped: number;
};

type PreparedModel = {
  readonly route: string;
  readonly name: string;
  readonly transport: string;
  readonly variants: readonly { id: string; settings: { reasoningEffort: string } }[];
  readonly limit?: { readonly context?: number; readonly output?: number };
  readonly resolution: ResolutionInfo;
};

export const register9RouterCatalog = (
  catalog: CatalogDraft,
  config: RouterConfig,
  models: readonly DiscoveredModel[],
  options: RegisterOptions = {},
): RegisterResult => {
  catalog.provider.update(PROVIDER_ID, (provider) => {
    provider.name = PROVIDER_NAME;
    provider.package = PROVIDER_PACKAGE;
    provider.disabled = false;
    provider.settings = {
      ...provider.settings,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    };
  });

  let registered = 0;
  let skipped = 0;
  const warnedRoutes = options.warnedRoutes ?? new Set<string>();
  for (const discovered of models) {
    // Resolve and validate everything before touching the draft, so the
    // update callback below only performs prepared assignments and can never
    // leave a half-mutated model behind.
    let prepared: PreparedModel;
    try {
      if (!discovered || typeof discovered.id !== "string") {
        throw new Error("invalid discovered model");
      }
      // One shared resolution drives both transport and reasoning variants so
      // they can never come from different providers.
      const resolved = resolveDirectModel(catalog, discovered.id, {
        warn: options.warn,
        warnedRoutes,
      });
      const variants = selectEfforts(resolved.candidate?.efforts ?? [], discovered).map(
        (effort) => ({ id: effort, settings: { reasoningEffort: effort } }),
      );
      prepared = {
        route: discovered.id,
        name: displayName(discovered.id),
        transport: resolved.package,
        variants,
        limit:
          discovered.contextLimit === undefined && discovered.outputLimit === undefined
            ? undefined
            : {
                ...(discovered.contextLimit === undefined
                  ? {}
                  : { context: discovered.contextLimit }),
                ...(discovered.outputLimit === undefined
                  ? {}
                  : { output: discovered.outputLimit }),
              },
        resolution: {
          route: discovered.id,
          providerID: resolved.candidate?.providerID,
          modelID: directModelID(discovered.id),
          package: resolved.package,
          packageSource: resolved.packageSource,
          candidateCount: resolved.candidateCount,
        },
      };
    } catch {
      skipped += 1;
      continue;
    }

    try {
      options.onResolved?.(prepared.resolution);
    } catch {
      // Resolution observability must never break registration.
    }

    try {
      const update = prepared;
      catalog.model.update(PROVIDER_ID, update.route, (model) => {
        model.name = update.name;
        model.modelID = update.route as unknown as typeof model.modelID;
        model.package = update.transport;
        model.enabled = true;
        model.status = "active";
        model.variants = update.variants as unknown as typeof model.variants;
        if (update.limit !== undefined) {
          model.limit = { ...model.limit, ...update.limit } as typeof model.limit;
        }
      });
      registered += 1;
    } catch {
      skipped += 1;
    }
  }

  if (skipped > 0) {
    safeWarn(
      options.warn,
      `opencode-9router-v2: skipped ${skipped} model(s) that failed to register`,
    );
  }

  return { registered, skipped };
};

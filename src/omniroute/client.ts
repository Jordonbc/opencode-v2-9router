import type {
  OmniRouteEnrichmentEntry,
  OmniRouteEnrichmentMap,
  OmniRouteProviderConnection,
  OmniRouteRawAutoCombo,
  OmniRouteRawCombo,
  OmniRouteRawModelEntry,
} from "./catalog.js";

export class OmniRouteClientError extends Error {
  override readonly name = "OmniRouteClientError";
}

export type FetchFn = typeof globalThis.fetch;

export type ClientOptions = {
  readonly fetch?: FetchFn;
  readonly timeoutMs?: number;
  /** Called with the failing endpoint path and a safe reason. */
  readonly onSourceError?: (endpoint: string, reason: string) => void;
};

const DEFAULT_TIMEOUT_MS = 10_000;

const trimSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
};

/** Inference-plane URL: tolerate roots with or without a `/vN` suffix. */
export const modelsURL = (baseURL: string): string => {
  const trimmed = trimSlashes(baseURL);
  return /\/v\d+$/u.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
};

/** Management-plane URL: always resolved from the gateway root. */
export const managementURL = (baseURL: string, path: string): string => {
  const trimmed = trimSlashes(baseURL).replace(/\/v\d+$/u, "");
  return `${trimmed}${path}`;
};

const timeoutSignal = (timeoutMs: number): AbortSignal => {
  const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  return AbortSignal.timeout(timeout);
};

export const getJSON = async (
  url: string,
  apiKey: string,
  options: ClientOptions = {},
): Promise<unknown> => {
  if (!apiKey) throw new OmniRouteClientError("omniroute request requires an API key");
  const fetcher = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: timeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    if ((error as { name?: unknown } | null | undefined)?.name === "TimeoutError") {
      throw new OmniRouteClientError("omniroute request timed out");
    }
    throw new OmniRouteClientError("omniroute request failed");
  }
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort cleanup must never replace the status error.
    }
    throw new OmniRouteClientError(`omniroute request returned HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new OmniRouteClientError("omniroute returned invalid JSON");
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asList = (payload: unknown, key: string): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload[key])) {
    return payload[key] as unknown[];
  }
  return [];
};

const keepEntriesWithID = <T>(items: unknown[]): T[] => {
  const out: T[] = [];
  for (const item of items) {
    if (isRecord(item) && typeof item.id === "string" && item.id.length > 0) {
      out.push(item as T);
    }
  }
  return out;
};

export const fetchOmniRouteModels = async (
  baseURL: string,
  apiKey: string,
  options: ClientOptions = {},
): Promise<OmniRouteRawModelEntry[]> => {
  const payload = await getJSON(modelsURL(baseURL), apiKey, options);
  return keepEntriesWithID<OmniRouteRawModelEntry>(asList(payload, "data"));
};

export const fetchOmniRouteCombos = async (
  baseURL: string,
  apiKey: string,
  options: ClientOptions = {},
): Promise<OmniRouteRawCombo[]> => {
  const endpoint = "/api/combos";
  try {
    const payload = await getJSON(managementURL(baseURL, endpoint), apiKey, options);
    return keepEntriesWithID<OmniRouteRawCombo>(asList(payload, "combos"));
  } catch (error) {
    options.onSourceError?.(endpoint, error instanceof Error ? error.message : String(error));
    throw error;
  }
};

/**
 * Older gateways answer 404 here: that is "no auto-combos", not a failure.
 * Every other refusal throws so the caller keeps last-known-good.
 */
export const fetchOmniRouteAutoCombos = async (
  baseURL: string,
  apiKey: string,
  options: ClientOptions = {},
): Promise<OmniRouteRawAutoCombo[]> => {
  const endpoint = "/api/combos/auto";
  const url = managementURL(baseURL, endpoint);
  if (!apiKey) return [];
  const fetcher = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: timeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const reason =
      (error as { name?: unknown } | null | undefined)?.name === "TimeoutError"
        ? "omniroute request timed out"
        : "omniroute request failed";
    options.onSourceError?.(endpoint, reason);
    throw new OmniRouteClientError(reason);
  }
  if (response.status === 404) {
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort cleanup only.
    }
    return [];
  }
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort cleanup must never replace the status error.
    }
    const reason = `omniroute request returned HTTP ${response.status}`;
    options.onSourceError?.(endpoint, reason);
    throw new OmniRouteClientError(reason);
  }
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    const reason = "omniroute returned invalid JSON";
    options.onSourceError?.(endpoint, reason);
    throw new OmniRouteClientError(reason);
  }
  return keepEntriesWithID<OmniRouteRawAutoCombo>(asList(payload, "combos"));
};

export const fetchOmniRouteProviders = async (
  baseURL: string,
  apiKey: string,
  options: ClientOptions = {},
): Promise<OmniRouteProviderConnection[]> => {
  const endpoint = "/api/providers";
  let payload: unknown;
  try {
    payload = await getJSON(managementURL(baseURL, endpoint), apiKey, options);
  } catch (error) {
    options.onSourceError?.(endpoint, error instanceof Error ? error.message : String(error));
    throw error;
  }
  const raw: unknown[] = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.connections)
      ? (payload.connections as unknown[])
      : asList(payload, "data");
  const out: OmniRouteProviderConnection[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.provider !== "string" || item.provider.length === 0) {
      continue;
    }
    const id = typeof item.id === "string" && item.id.length > 0 ? item.id : item.provider;
    // Allowlist the fields the usable filter reads. Connection rows may
    // carry credential material that must never reach memory snapshots,
    // let alone the on-disk cache.
    out.push({
      id,
      provider: item.provider,
      ...(typeof item.isActive === "boolean" ? { isActive: item.isActive } : {}),
      ...(typeof item.testStatus === "string" ? { testStatus: item.testStatus } : {}),
    });
  }
  return out;
};

const parsePricingSlot = (
  slot: unknown,
): { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined => {
  if (!isRecord(slot)) return undefined;
  const parsed: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {};
  if (typeof slot.input === "number" && Number.isFinite(slot.input)) parsed.input = slot.input;
  if (typeof slot.output === "number" && Number.isFinite(slot.output)) parsed.output = slot.output;
  const cacheRead =
    typeof slot.cached === "number" && Number.isFinite(slot.cached)
      ? slot.cached
      : typeof slot.cacheRead === "number" && Number.isFinite(slot.cacheRead)
        ? slot.cacheRead
        : undefined;
  if (cacheRead !== undefined) parsed.cacheRead = cacheRead;
  const cacheWrite =
    typeof slot.cache_creation === "number" && Number.isFinite(slot.cache_creation)
      ? slot.cache_creation
      : typeof slot.cacheWrite === "number" && Number.isFinite(slot.cacheWrite)
        ? slot.cacheWrite
        : undefined;
  if (cacheWrite !== undefined) parsed.cacheWrite = cacheWrite;
  return Object.keys(parsed).length > 0 ? parsed : undefined;
};

/**
 * Best-effort enrichment overlay. Each source is independent: one missing
 * source still surfaces the others. Throws only when every source failed,
 * so the caller can keep last-known-good instead of an empty map.
 */
export const fetchOmniRouteEnrichment = async (
  baseURL: string,
  apiKey: string,
  options: ClientOptions = {},
): Promise<OmniRouteEnrichmentMap> => {
  const out: OmniRouteEnrichmentMap = new Map();
  if (!baseURL || !apiKey) return out;
  const report = (endpoint: string, reason: string): void => {
    try {
      options.onSourceError?.(endpoint, reason);
    } catch {
      // Observability must never break enrichment.
    }
  };

  let catalogFailed = true;
  try {
    const payload = await getJSON(managementURL(baseURL, "/api/pricing/models"), apiKey, options);
    const providers =
      isRecord(payload) && isRecord(payload.providers)
        ? (payload.providers as Record<string, unknown>)
        : isRecord(payload)
          ? (payload as Record<string, unknown>)
          : {};
    for (const [alias, slot] of Object.entries(providers)) {
      if (!isRecord(slot) || !Array.isArray(slot.models)) continue;
      const canonical =
        typeof slot.id === "string" && slot.id.length > 0 ? slot.id : alias;
      const displayName =
        typeof slot.name === "string" && slot.name.trim().length > 0
          ? slot.name.trim()
          : undefined;
      for (const model of slot.models as unknown[]) {
        if (!isRecord(model) || typeof model.id !== "string" || model.id.length === 0) continue;
        const entry: OmniRouteEnrichmentEntry = { providerAlias: alias, providerCanonical: canonical };
        if (displayName !== undefined) entry.providerDisplayName = displayName;
        if (typeof model.name === "string" && model.name.trim().length > 0) {
          entry.name = model.name as string;
        }
        const namespaced = `${alias}/${model.id as string}`;
        if (!out.has(namespaced)) out.set(namespaced, entry);
        // Bare keys get their own copy so a later price write for one
        // provider can never land on another provider's same-named model.
        if (!out.has(model.id as string)) out.set(model.id as string, { ...entry });
      }
    }
    catalogFailed = false;
  } catch (error) {
    report("/api/pricing/models", error instanceof Error ? error.message : String(error));
  }

  let pricingEmpty = true;
  try {
    const payload = await getJSON(managementURL(baseURL, "/api/pricing"), apiKey, options);
    if (isRecord(payload)) {
      for (const [alias, slot] of Object.entries(payload)) {
        if (!isRecord(slot)) continue;
        for (const [modelID, raw] of Object.entries(slot)) {
          const pricing = parsePricingSlot(raw);
          if (!pricing) continue;
          pricingEmpty = false;
          const namespaced = `${alias}/${modelID}`;
          const existingNamespaced = out.get(namespaced);
          if (existingNamespaced) {
            existingNamespaced.pricing = { ...existingNamespaced.pricing, ...pricing };
          } else {
            out.set(namespaced, { pricing });
          }
          const existingBare = out.get(modelID);
          const bareBelongsHere =
            existingBare === undefined ||
            existingBare.providerAlias === undefined ||
            existingBare.providerAlias === alias;
          if (!bareBelongsHere) continue;
          if (existingBare) {
            existingBare.pricing = { ...existingBare.pricing, ...pricing };
          } else {
            out.set(modelID, { pricing });
          }
        }
      }
    }
  } catch (error) {
    report("/api/pricing", error instanceof Error ? error.message : String(error));
  }

  try {
    const payload = await getJSON(
      managementURL(baseURL, "/api/free-tier/summary"),
      apiKey,
      options,
    );
    const perModel: unknown[] =
      isRecord(payload) && Array.isArray(payload.perModel)
        ? (payload.perModel as unknown[])
        : Array.isArray(payload)
          ? payload
          : [];
    for (const item of perModel) {
      if (!isRecord(item)) continue;
      if (typeof item.modelId !== "string" || typeof item.freeType !== "string") continue;
      if (item.modelId.length === 0 || item.freeType.length === 0) continue;
      const provider = typeof item.provider === "string" ? item.provider : "";
      const displayName = typeof item.displayName === "string" ? item.displayName : "";
      for (const key of [`${provider}/${item.modelId}`, item.modelId, displayName]) {
        if (!key || key === "/") continue;
        const entry = out.get(key);
        if (!entry) continue;
        entry.freeType = item.freeType as OmniRouteEnrichmentEntry["freeType"];
        if (typeof item.monthlyTokens === "number" && Number.isFinite(item.monthlyTokens)) {
          entry.monthlyTokens = item.monthlyTokens;
        }
        if (typeof item.creditTokens === "number" && Number.isFinite(item.creditTokens)) {
          entry.creditTokens = item.creditTokens;
        }
        break;
      }
    }
  } catch (error) {
    // Free decoration is optional; its absence only drops the budget suffix.
    report("/api/free-tier/summary", error instanceof Error ? error.message : String(error));
  }

  if (catalogFailed && pricingEmpty && out.size === 0) {
    throw new OmniRouteClientError("omniroute enrichment sources failed");
  }
  return out;
};

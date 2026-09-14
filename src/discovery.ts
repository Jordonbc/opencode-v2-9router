import type { RouterConfig } from "./config.js";

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
export const MAX_DISCOVERY_BYTES = 1_048_576;
export const MAX_MODELS = 1_000;
export const MAX_MODEL_ID_LENGTH = 512;

export class DiscoveryError extends Error {
  override readonly name = "DiscoveryError";
}

export type DiscoveryOptions = {
  readonly fetch?: typeof globalThis.fetch;
  readonly maxBytes?: number;
  readonly maxModels?: number;
  readonly timeoutMs?: number;
  /** Called when usable models are dropped because the payload exceeded maxModels. */
  readonly onTruncated?: (dropped: number) => void;
};

export type DiscoveredModel = {
  readonly id: string;
  readonly reasoning: boolean;
  readonly thinkingCanDisable: boolean;
  readonly contextLimit?: number;
  readonly outputLimit?: number;
};

const isModelID = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  if (!value || value !== value.trim() || value.length > MAX_MODEL_ID_LENGTH) return false;
  return !/[\u0000-\u001f\u007f]/u.test(value);
};

const tokenLimit = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
};

const parseModel = (item: unknown): DiscoveredModel | undefined => {
  if (!item || typeof item !== "object") return undefined;

  const model = item as {
    id?: unknown;
    capabilities?: unknown;
    context_length?: unknown;
    max_completion_tokens?: unknown;
  };
  if (!isModelID(model.id)) return undefined;

  const capabilities =
    model.capabilities && typeof model.capabilities === "object"
      ? (model.capabilities as Record<string, unknown>)
      : {};

  const contextLimit = tokenLimit(model.context_length, capabilities.contextWindow);
  const outputLimit = tokenLimit(model.max_completion_tokens, capabilities.maxOutput);

  return {
    id: model.id,
    reasoning: capabilities.reasoning === true,
    thinkingCanDisable: capabilities.thinkingCanDisable === true,
    ...(contextLimit === undefined ? {} : { contextLimit }),
    ...(outputLimit === undefined ? {} : { outputLimit }),
  };
};

export type DiscoveryResult = {
  readonly models: DiscoveredModel[];
  /** Usable models dropped because the payload exceeded maxModels. */
  readonly dropped: number;
};

export const parseModelsPayload = (
  payload: unknown,
  maxModels = MAX_MODELS,
): DiscoveryResult => {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new DiscoveryError("9router returned an invalid /models response");
  }

  const data = (payload as { data: unknown[] }).data;

  const models = new Map<string, DiscoveredModel>();
  let dropped = 0;
  for (const item of data) {
    const model = parseModel(item);
    if (!model || models.has(model.id)) continue;
    if (models.size >= maxModels) {
      dropped += 1;
      continue;
    }
    models.set(model.id, model);
  }

  return { models: [...models.values()], dropped };
};

const cancelReader = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
  try {
    await reader.cancel();
  } catch {
    // The stream may already be closed, errored, or released on some runtimes.
  }
};

const readBoundedBody = async (response: Response, maxBytes: number): Promise<string> => {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new DiscoveryError("9router /models response is too large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;

      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await cancelReader(reader);
        throw new DiscoveryError("9router /models response is too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    const result = text + decoder.decode();
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released on some runtimes.
    }
    return result;
  } catch (error) {
    await cancelReader(reader);
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released after cancel on some runtimes.
    }
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError("Unable to read the 9router /models response");
  }
};

export const discoverModels = async (
  config: RouterConfig,
  options: DiscoveryOptions = {},
): Promise<DiscoveredModel[]> => {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_DISCOVERY_BYTES;
  const maxModels = options.maxModels ?? MAX_MODELS;
  const onTruncated = options.onTruncated;

  let signal: AbortSignal;
  try {
    signal = AbortSignal.timeout(timeoutMs);
  } catch {
    throw new DiscoveryError("9router model discovery failed");
  }

  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new DiscoveryError("9router model discovery failed");
  }
  if (!Number.isSafeInteger(maxModels) || maxModels <= 0) {
    throw new DiscoveryError("9router model discovery failed");
  }

  try {
    const response = await fetcher(`${config.baseURL}/models`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      redirect: "error",
      signal,
    });

    if (!response.ok) {
      throw new DiscoveryError(`9router model discovery returned HTTP ${response.status}`);
    }

    const text = await readBoundedBody(response, maxBytes);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new DiscoveryError("9router returned invalid JSON from /models");
    }

    const { models, dropped } = parseModelsPayload(payload, maxModels);
    if (dropped > 0 && onTruncated) onTruncated(dropped);
    return models;
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    if (signal.aborted) throw new DiscoveryError("9router model discovery timed out");
    throw new DiscoveryError("9router model discovery failed");
  }
};

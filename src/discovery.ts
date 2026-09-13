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
};

const isModelID = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  if (!value || value !== value.trim() || value.length > MAX_MODEL_ID_LENGTH) return false;
  return !/[\u0000-\u001f\u007f]/u.test(value);
};

export const parseModelsPayload = (payload: unknown, maxModels = MAX_MODELS): string[] => {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new DiscoveryError("9router returned an invalid /models response");
  }

  const data = (payload as { data: unknown[] }).data;
  if (data.length > maxModels) {
    throw new DiscoveryError(`9router returned more than ${maxModels} models`);
  }

  const seen = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (isModelID(id)) seen.add(id);
  }

  return [...seen];
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
        await reader.cancel();
        throw new DiscoveryError("9router /models response is too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError("Unable to read the 9router /models response");
  } finally {
    reader.releaseLock();
  }
};

export const discoverModels = async (
  config: RouterConfig,
  options: DiscoveryOptions = {},
): Promise<string[]> => {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_DISCOVERY_BYTES;
  const maxModels = options.maxModels ?? MAX_MODELS;
  const signal = AbortSignal.timeout(timeoutMs);

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

    return parseModelsPayload(payload, maxModels);
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    if (signal.aborted) throw new DiscoveryError("9router model discovery timed out");
    throw new DiscoveryError("9router model discovery failed");
  }
};

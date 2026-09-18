import { isHttpUrl, type ApiFormatV2, type LogLevel } from "./upstream/shared/index.js";

export interface OmniRouteConfig {
  providerId: string;
  displayName: string;
  baseURL: string;
  apiKey?: string;
  managementReadToken?: string;
  timeoutMs: number;
  timeouts: {
    models: number;
    combos: number;
    autoCombos: number;
    enrichment: number;
  };
  modelCacheTtlMs: number;
  visibleModels?: string[];
  hiddenModels?: string[];
  usableOnly: boolean;
  enrichment: boolean;
  geminiSanitization: boolean;
  providerTag: boolean;
  apiFormat?: ApiFormatV2;
  logLevel?: LogLevel;
  startupDebug: boolean;
}

const bool = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
};

const positive = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const strings = (name: string): string[] | undefined => {
  const value = process.env[name];
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed;
  } catch {}
  return value.split(",").map((x) => x.trim()).filter(Boolean);
};

const json = <T>(name: string): T | undefined => {
  const value = process.env[name];
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

export const loadOmniRouteConfig = (): OmniRouteConfig | undefined => {
  const rawURL = process.env.OPENCODE_OMNIROUTE_URL?.trim();
  if (!rawURL) return undefined;
  if (!isHttpUrl(rawURL)) {
    console.warn("opencode-9router-v2: OPENCODE_OMNIROUTE_URL must be an http(s) URL");
    return undefined;
  }

  const providerId = (process.env.OPENCODE_OMNIROUTE_PROVIDER_ID ?? "omniroute").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(providerId) || providerId === "." || providerId === "..") {
    console.warn("opencode-9router-v2: invalid OPENCODE_OMNIROUTE_PROVIDER_ID");
    return undefined;
  }

  const timeoutMs = positive("OPENCODE_OMNIROUTE_TIMEOUT_MS", 10_000);
  const timeoutOverrides = json<Partial<OmniRouteConfig["timeouts"]>>("OPENCODE_OMNIROUTE_TIMEOUTS");

  return {
    providerId,
    displayName: process.env.OPENCODE_OMNIROUTE_DISPLAY_NAME?.trim() || "OmniRoute",
    baseURL: rawURL.replace(/\/+$/u, ""),
    apiKey: process.env.OPENCODE_OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY,
    managementReadToken:
      process.env.OPENCODE_OMNIROUTE_MANAGEMENT_API_KEY ||
      process.env.OMNIROUTE_MANAGEMENT_API_KEY,
    timeoutMs,
    timeouts: {
      models: timeoutOverrides?.models ?? timeoutMs,
      combos: timeoutOverrides?.combos ?? timeoutMs,
      autoCombos: timeoutOverrides?.autoCombos ?? 5_000,
      enrichment: timeoutOverrides?.enrichment ?? timeoutMs,
    },
    modelCacheTtlMs: positive("OPENCODE_OMNIROUTE_MODEL_CACHE_TTL_MS", 300_000),
    visibleModels: strings("OPENCODE_OMNIROUTE_VISIBLE_MODELS"),
    hiddenModels: strings("OPENCODE_OMNIROUTE_HIDDEN_MODELS"),
    usableOnly: bool("OPENCODE_OMNIROUTE_USABLE_ONLY", false),
    enrichment: bool("OPENCODE_OMNIROUTE_ENRICHMENT", true),
    geminiSanitization: bool("OPENCODE_OMNIROUTE_GEMINI_SANITIZATION", true),
    providerTag: bool("OPENCODE_OMNIROUTE_PROVIDER_TAG", true),
    apiFormat: json<ApiFormatV2>("OPENCODE_OMNIROUTE_API_FORMAT"),
    logLevel: process.env.OPENCODE_OMNIROUTE_LOG_LEVEL as LogLevel | undefined,
    startupDebug: bool("OPENCODE_OMNIROUTE_STARTUP_DEBUG", false),
  };
};

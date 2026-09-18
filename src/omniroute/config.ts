import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const OMNIROUTE_CONFIG_FILE = join(
  homedir(),
  ".config",
  "environment.d",
  "omniroute.conf",
);

export const DEFAULT_PROVIDER_ID = "omniroute";
export const DEFAULT_DISPLAY_NAME = "OmniRoute";
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_AUTO_COMBOS_TIMEOUT_MS = 5_000;
export const DEFAULT_CACHE_TTL_MS = 300_000;
export const DEFAULT_ANTHROPIC_PREFIXES = ["cc", "claude", "anthropic", "kiro", "kr"] as const;

export type OmniRouteLogLevel = "error" | "warn" | "info" | "debug";

export type OmniRouteTimeouts = {
  readonly models: number;
  readonly combos: number;
  readonly autoCombos: number;
  readonly enrichment: number;
};

export type OmniRouteConfig = {
  readonly providerID: string;
  readonly displayName: string;
  /** Gateway root without any trailing `/v1` (management-plane base). */
  readonly gatewayRoot: string;
  /** Inference base URL (`<gatewayRoot>/v1`). */
  readonly baseURL: string;
  readonly apiKey: string;
  readonly managementKey: string | undefined;
  readonly timeoutMs: number;
  readonly timeouts: OmniRouteTimeouts;
  readonly cacheTtlMs: number;
  readonly usableOnly: boolean;
  readonly enrichment: boolean;
  readonly providerTag: boolean;
  readonly geminiSanitization: boolean;
  readonly visibleModels: readonly string[];
  readonly hiddenModels: readonly string[];
  readonly allowAnthropic: boolean;
  readonly anthropicModels: readonly string[];
  /** Explicit prefix list; absent means the default compatibility prefixes. */
  readonly anthropicPrefixes: readonly string[] | undefined;
  readonly logLevel: OmniRouteLogLevel;
};

export type OmniRouteLoadResult =
  | { readonly ok: true; readonly value: OmniRouteConfig | undefined }
  | { readonly ok: false; readonly error: OmniRouteConfigError };

export class OmniRouteConfigError extends Error {
  override readonly name = "OmniRouteConfigError";
}

type Environment = Readonly<Record<string, string | undefined>>;

const CONFIG_KEYS = new Set([
  "OPENCODE_OMNIROUTE_URL",
  "OPENCODE_OMNIROUTE_API_KEY",
  "OPENCODE_OMNIROUTE_MANAGEMENT_API_KEY",
]);

const unquote = (value: string): string => {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value.at(-1);
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
};

export const parseOmniRouteEnvironmentFile = (contents: string): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    const key = assignment.slice(0, separator).trim();
    if (!CONFIG_KEYS.has(key)) continue;
    parsed[key] = unquote(assignment.slice(separator + 1).trim());
  }
  return parsed;
};

/** Gateway root: http(s), no credentials/query/fragment, no trailing `/vN`. */
export const normalizeGatewayRoot = (input: string): string => {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new OmniRouteConfigError("OPENCODE_OMNIROUTE_URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OmniRouteConfigError("OPENCODE_OMNIROUTE_URL must use http or https");
  }
  if (
    url.username ||
    url.password ||
    url.search !== "" ||
    url.hash !== "" ||
    trimmed.includes("?") ||
    trimmed.includes("#")
  ) {
    throw new OmniRouteConfigError(
      "OPENCODE_OMNIROUTE_URL must not contain credentials, a query, or a fragment",
    );
  }
  const withoutSlashes = url.toString().replace(/\/+$/u, "");
  // Tolerate both `https://host` and `https://host/v1` forms.
  return withoutSlashes.replace(/\/v\d+$/u, "");
};

export const isProviderID = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  if (value === "." || value === "..") return false;
  return /^[A-Za-z0-9._-]+$/u.test(value);
};

const readFallback = async (path: string): Promise<Record<string, string>> => {
  try {
    return parseOmniRouteEnvironmentFile(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new OmniRouteConfigError(`Unable to read the omniroute environment file at ${path}`);
  }
};

const firstPresent = (...values: (string | undefined)[]): string | undefined => {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const parseBool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const parseList = (value: string | undefined): readonly string[] => {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

const parseOptionalList = (value: string | undefined): readonly string[] | undefined => {
  const list = parseList(value);
  return list.length > 0 ? list : undefined;
};

const parseLogLevel = (value: string | undefined): OmniRouteLogLevel => {
  if (value === undefined) return "warn";
  const normalized = value.trim().toLowerCase();
  if (normalized === "error" || normalized === "warn" || normalized === "info" || normalized === "debug") {
    return normalized;
  }
  return "warn";
};

export const loadOmniRouteConfig = async (
  environment: Environment = process.env,
  fallbackPath = OMNIROUTE_CONFIG_FILE,
): Promise<OmniRouteLoadResult> => {
  try {
    const envURL = environment.OPENCODE_OMNIROUTE_URL?.trim();
    const envKey = firstPresent(
      environment.OPENCODE_OMNIROUTE_API_KEY,
      environment.OMNIROUTE_API_KEY,
    );
    const envMgmt = firstPresent(
      environment.OPENCODE_OMNIROUTE_MANAGEMENT_API_KEY,
      environment.OMNIROUTE_MANAGEMENT_API_KEY,
    );
    const needsFallback = !envURL || !envKey;
    const fallback = needsFallback ? await readFallback(fallbackPath) : {};
    const rawURL = envURL || fallback.OPENCODE_OMNIROUTE_URL?.trim();
    const apiKey = envKey || fallback.OPENCODE_OMNIROUTE_API_KEY?.trim() || "";
    const managementKey =
      envMgmt || fallback.OPENCODE_OMNIROUTE_MANAGEMENT_API_KEY?.trim() || undefined;

    // Absent URL means OmniRoute is simply not configured: disabled, silent.
    if (!rawURL) return { ok: true, value: undefined };

    const gatewayRoot = normalizeGatewayRoot(rawURL);
    const providerID =
      environment.OPENCODE_OMNIROUTE_PROVIDER_ID?.trim() || DEFAULT_PROVIDER_ID;
    if (!isProviderID(providerID)) {
      throw new OmniRouteConfigError("OPENCODE_OMNIROUTE_PROVIDER_ID is invalid");
    }
    const timeoutMs = parsePositiveInt(
      environment.OPENCODE_OMNIROUTE_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    );
    return {
      ok: true,
      value: {
        providerID,
        displayName:
          environment.OPENCODE_OMNIROUTE_DISPLAY_NAME?.trim() || DEFAULT_DISPLAY_NAME,
        gatewayRoot,
        baseURL: `${gatewayRoot}/v1`,
        apiKey,
        managementKey:
          managementKey !== undefined && managementKey !== "" ? managementKey : undefined,
        timeoutMs,
        timeouts: {
          models: parsePositiveInt(environment.OPENCODE_OMNIROUTE_MODELS_TIMEOUT_MS, timeoutMs),
          combos: parsePositiveInt(environment.OPENCODE_OMNIROUTE_COMBOS_TIMEOUT_MS, timeoutMs),
          autoCombos: parsePositiveInt(
            environment.OPENCODE_OMNIROUTE_AUTO_COMBOS_TIMEOUT_MS,
            DEFAULT_AUTO_COMBOS_TIMEOUT_MS,
          ),
          enrichment: parsePositiveInt(
            environment.OPENCODE_OMNIROUTE_ENRICHMENT_TIMEOUT_MS,
            timeoutMs,
          ),
        },
        cacheTtlMs: parsePositiveInt(
          environment.OPENCODE_OMNIROUTE_CACHE_TTL_MS,
          DEFAULT_CACHE_TTL_MS,
        ),
        usableOnly: parseBool(environment.OPENCODE_OMNIROUTE_USABLE_ONLY, false),
        enrichment: parseBool(environment.OPENCODE_OMNIROUTE_ENRICHMENT, true),
        providerTag: parseBool(environment.OPENCODE_OMNIROUTE_PROVIDER_TAG, true),
        geminiSanitization: parseBool(
          environment.OPENCODE_OMNIROUTE_GEMINI_SANITIZATION,
          true,
        ),
        visibleModels: parseList(environment.OPENCODE_OMNIROUTE_VISIBLE_MODELS),
        hiddenModels: parseList(environment.OPENCODE_OMNIROUTE_HIDDEN_MODELS),
        allowAnthropic: parseBool(environment.OPENCODE_OMNIROUTE_ALLOW_ANTHROPIC, false),
        anthropicModels: parseList(environment.OPENCODE_OMNIROUTE_ANTHROPIC_MODELS),
        anthropicPrefixes: parseOptionalList(environment.OPENCODE_OMNIROUTE_ANTHROPIC_PREFIXES),
        logLevel: parseLogLevel(environment.OPENCODE_OMNIROUTE_LOG_LEVEL),
      },
    };
  } catch (error) {
    const safeError =
      error instanceof OmniRouteConfigError
        ? error
        : new OmniRouteConfigError("Invalid omniroute configuration");
    return { ok: false, error: safeError };
  }
};

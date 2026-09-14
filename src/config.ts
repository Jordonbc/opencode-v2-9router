import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_FILE = join(homedir(), ".config", "environment.d", "9router.conf");

export type RouterConfig = {
  readonly apiKey: string;
  readonly baseURL: string;
};

export type ConfigResult =
  | { readonly ok: true; readonly value: RouterConfig }
  | { readonly ok: false; readonly error: ConfigError };

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Environment = Readonly<Record<string, string | undefined>>;

const CONFIG_KEYS = new Set(["OPENCODE_9ROUTER_URL", "OPENCODE_9ROUTER_API_KEY"]);

const unquote = (value: string): string => {
  if (value.length < 2) return value;

  const first = value[0];
  const last = value.at(-1);
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }

  return value;
};

export const parseEnvironmentFile = (contents: string): Record<string, string> => {
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

export const normalizeBaseURL = (input: string): string => {
  const trimmed = input.trim();
  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError("OPENCODE_9ROUTER_URL must be a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("OPENCODE_9ROUTER_URL must use http or https");
  }
  if (
    url.username ||
    url.password ||
    url.search !== "" ||
    url.hash !== "" ||
    trimmed.includes("?") ||
    trimmed.includes("#")
  ) {
    throw new ConfigError("OPENCODE_9ROUTER_URL must not contain credentials, a query, or a fragment");
  }

  url.pathname = url.pathname.replace(/\/+$/u, "");
  if (!url.pathname.endsWith("/v1")) {
    throw new ConfigError("OPENCODE_9ROUTER_URL must end with /v1");
  }

  return url.toString().replace(/\/$/u, "");
};

const readFallback = async (path: string): Promise<Record<string, string>> => {
  try {
    return parseEnvironmentFile(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(`Unable to read the 9router environment file at ${path}`);
  }
};

export const loadConfig = async (
  environment: Environment = process.env,
  fallbackPath = CONFIG_FILE,
): Promise<ConfigResult> => {
  try {
    const envURL = environment.OPENCODE_9ROUTER_URL?.trim();
    const envKey = environment.OPENCODE_9ROUTER_API_KEY?.trim();
    const needsFallback = !envURL || !envKey;
    const fallback = needsFallback ? await readFallback(fallbackPath) : {};
    const rawURL = envURL || fallback.OPENCODE_9ROUTER_URL;
    const apiKey = envKey || fallback.OPENCODE_9ROUTER_API_KEY?.trim();

    if (!rawURL) {
      return { ok: false, error: new ConfigError("OPENCODE_9ROUTER_URL is not configured") };
    }
    if (!apiKey) {
      return { ok: false, error: new ConfigError("OPENCODE_9ROUTER_API_KEY is not configured") };
    }

    return { ok: true, value: { apiKey, baseURL: normalizeBaseURL(rawURL) } };
  } catch (error) {
    const safeError = error instanceof ConfigError ? error : new ConfigError("Invalid 9router configuration");
    return { ok: false, error: safeError };
  }
};

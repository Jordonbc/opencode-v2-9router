type ConnectionProbe = {
  readonly active?: (integrationID: string) => Promise<unknown>;
  readonly resolve?: (connection: unknown) => Promise<unknown>;
};

type IntegrationHolder = {
  readonly integration?: {
    readonly connection?: ConnectionProbe;
  } | null;
};

/** Stored-credential key, or undefined when none is available. Never throws. */
export const readConnectionKey = async (
  context: unknown,
  integrationID: string,
  warn?: (message: string) => void,
): Promise<string | undefined> => {
  try {
    const connection = (context as IntegrationHolder | null | undefined)?.integration?.connection;
    if (!connection || typeof connection.active !== "function" || typeof connection.resolve !== "function") {
      return undefined;
    }
    const active = await connection.active(integrationID);
    if (!active) return undefined;
    const credential = await connection.resolve(active);
    if (!credential || typeof credential !== "object") return undefined;
    const record = credential as { type?: unknown; key?: unknown };
    if (record.type !== "key") {
      try {
        warn?.(
          "opencode-9router-v2: omniroute ignoring a stored non-key credential; an API key is required",
        );
      } catch {
        // Observability must never break credential resolution.
      }
      return undefined;
    }
    return typeof record.key === "string" && record.key.length > 0 ? record.key : undefined;
  } catch {
    return undefined;
  }
};

export type KeychainInput = {
  /** Key from the OpenCode stored credential (wins over environment). */
  readonly stored?: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

const firstKey = (...values: (string | undefined)[]): string => {
  for (const value of values) {
    if (value !== undefined && value.length > 0) return value;
  }
  return "";
};

/**
 * Credential precedence: OpenCode stored credential, then
 * OPENCODE_OMNIROUTE_API_KEY, then OMNIROUTE_API_KEY. Management endpoints
 * use the distinct management key with the same compat fallback, else the
 * inference key stands in (gateways may reject it with 401/403, which
 * degrades gracefully per endpoint).
 */
export const resolveKeychain = (input: KeychainInput): { readonly apiKey: string; readonly managementKey: string | undefined } => {
  const pick = (primary: string | undefined, compat: string | undefined): string | undefined => {
    const value = firstKey(primary, compat);
    return value === "" ? undefined : value;
  };
  const apiKey =
    (input.stored && input.stored.length > 0 ? input.stored : undefined) ??
    pick(input.environment.OPENCODE_OMNIROUTE_API_KEY, input.environment.OMNIROUTE_API_KEY) ??
    "";
  const managementKey = pick(
    input.environment.OPENCODE_OMNIROUTE_MANAGEMENT_API_KEY,
    input.environment.OMNIROUTE_MANAGEMENT_API_KEY,
  );
  return { apiKey, managementKey };
};

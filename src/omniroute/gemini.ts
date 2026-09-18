const REJECTED_KEYWORDS = new Set(["$schema", "additionalProperties"]);

/** Keys whose value is itself a schema. */
const SCHEMA_VALUE_KEYS = [
  "items",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "contentSchema",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;

/** Keys whose value maps arbitrary names to schemas; never keyword space. */
const SCHEMA_MAP_KEYS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
] as const;

/** Keys whose value is a list of schemas. */
const SCHEMA_LIST_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Gemini-routed model ids: bare (`gemini-2.5-flash`), canonical
 * (`models/gemini-1.5-pro`) and gateway-prefixed (`google/gemini-2.0-flash`).
 * Anchored on the last path segment so unrelated ids containing "gemini"
 * elsewhere are not claimed.
 */
const GEMINI_MODEL_ID =
  /^gemini(?:[-_.](?:\d|pro|flash|ultra|nano|exp|thinking|embedding|live|imagen)|$)/iu;

export const isGeminiModelID = (modelID: unknown): boolean => {
  if (typeof modelID !== "string") return false;
  const segment = modelID.split("/").pop() ?? "";
  return GEMINI_MODEL_ID.test(segment);
};

const hasRef = (node: unknown): boolean => {
  if (Array.isArray(node)) return node.some(hasRef);
  if (!isRecord(node)) return false;
  if ("$ref" in node) return true;
  for (const key of SCHEMA_VALUE_KEYS) {
    if (hasRef(node[key])) return true;
  }
  for (const key of SCHEMA_LIST_KEYS) {
    if (hasRef(node[key])) return true;
  }
  for (const key of SCHEMA_MAP_KEYS) {
    const map = node[key];
    if (isRecord(map) && Object.values(map).some(hasRef)) return true;
  }
  return false;
};

/**
 * Strip rejected keywords in place, walking only positions where a schema
 * can appear. Property names are never treated as keywords, so a parameter
 * literally called `additionalProperties` keeps it.
 */
const stripAtSchemaPositions = (node: Record<string, unknown>): boolean => {
  let changed = false;
  for (const keyword of REJECTED_KEYWORDS) {
    if (keyword in node) {
      delete node[keyword];
      changed = true;
    }
  }
  for (const key of SCHEMA_VALUE_KEYS) {
    const child = node[key];
    if (isRecord(child)) {
      changed = stripAtSchemaPositions(child) || changed;
      continue;
    }
    // `items` also takes the tuple form: one schema per position.
    if (key === "items" && Array.isArray(child)) {
      for (const item of child) {
        if (isRecord(item)) changed = stripAtSchemaPositions(item) || changed;
      }
    }
  }
  for (const key of SCHEMA_LIST_KEYS) {
    const list = node[key];
    if (Array.isArray(list)) {
      for (const child of list) {
        if (isRecord(child)) changed = stripAtSchemaPositions(child) || changed;
      }
    }
  }
  for (const key of SCHEMA_MAP_KEYS) {
    const map = node[key];
    if (!isRecord(map)) continue;
    for (const child of Object.values(map)) {
      if (isRecord(child)) changed = stripAtSchemaPositions(child) || changed;
    }
  }
  return changed;
};

export type ToolWithInputSchema = {
  readonly inputSchema?: unknown;
} & Record<string, unknown>;

/**
 * Copy of `tools` with Gemini-rejected keywords removed from input schemas,
 * or undefined when nothing needed stripping (lets the caller forward the
 * original array without cloning). Tools carrying `$ref` or unreadable
 * schemas pass through untouched: widening or dropping them would be worse
 * than letting the gateway answer.
 */
export const sanitizeToolInputSchemas = <T extends ToolWithInputSchema>(
  tools: readonly T[] | undefined,
): T[] | undefined => {
  if (!tools || tools.length === 0) return undefined;
  let changed = false;
  const out: T[] = tools.map((tool) => {
    if (!isRecord(tool.inputSchema) || hasRef(tool.inputSchema)) return tool;
    let schema: Record<string, unknown>;
    try {
      schema = structuredClone(tool.inputSchema) as Record<string, unknown>;
    } catch {
      return tool;
    }
    if (!stripAtSchemaPositions(schema)) return tool;
    changed = true;
    return { ...tool, inputSchema: schema } as T;
  });
  return changed ? out : undefined;
};

export type LanguageModelLike = {
  doGenerate: (options: CallOptions) => unknown;
  doStream: (options: CallOptions) => unknown;
} & Record<string, unknown>;

type CallOptions = { readonly tools?: unknown } & Record<string, unknown>;

/**
 * Wrap an AI SDK language model so Gemini-bound requests carry cleaned tool
 * schemas. Non-Gemini models return untouched.
 */
export const wrapLanguageModelForGemini = <T extends LanguageModelLike>(
  language: T | undefined,
  modelID: string,
): T | undefined => {
  if (!language || !isGeminiModelID(modelID)) return language;
  const source: LanguageModelLike = language;
  const clean = (options: CallOptions): CallOptions => {
    const tools = options.tools as readonly ToolWithInputSchema[] | undefined;
    const cleaned = sanitizeToolInputSchemas(Array.isArray(tools) ? tools : undefined);
    if (!cleaned) return options;
    return { ...options, tools: cleaned };
  };
  // Prototype-linked so every other member (including accessors and future
  // SDK additions) keeps working untouched.
  const wrapped: LanguageModelLike = Object.create(source as object);
  wrapped.doGenerate = (options) => source.doGenerate(clean(options));
  wrapped.doStream = (options) => source.doStream(clean(options));
  return wrapped as unknown as T;
};

import type { Plugin } from "@opencode-ai/plugin";
import type { RouterConfig } from "./config.js";
import type { DiscoveredModel } from "./discovery.js";

export const PROVIDER_ID = "9router";
export const PROVIDER_NAME = "9Router";
export const PROVIDER_PACKAGE = "aisdk:@ai-sdk/openai-compatible";

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

export const directReasoningEfforts = (
  catalog: CatalogDraft,
  routeID: string,
): ReasoningEffort[] => {
  const modelID = directModelID(routeID);

  for (const record of catalog.provider.list()) {
    if (String(record.provider.id) === PROVIDER_ID) continue;

    const direct = record.models.get(modelID);
    if (!direct) continue;

    const efforts = direct.variants
      .map((variant) => variant.settings?.reasoningEffort)
      .filter(isReasoningEffort);
    if (efforts.length > 0) return [...new Set(efforts)];
  }

  return [];
};

export const directModelPackage = (catalog: CatalogDraft, routeID: string): string => {
  const modelID = directModelID(routeID);

  for (const record of catalog.provider.list()) {
    if (String(record.provider.id) === PROVIDER_ID) continue;

    const direct = record.models.get(modelID);
    if (!direct) continue;

    if (typeof direct.package === "string" && direct.package.length > 0) {
      return direct.package;
    }
    if (typeof record.provider.package === "string" && record.provider.package.length > 0) {
      return record.provider.package;
    }
  }

  return PROVIDER_PACKAGE;
};

export const reasoningVariants = (
  catalog: CatalogDraft,
  model: Pick<DiscoveredModel, "id" | "reasoning" | "thinkingCanDisable">,
): Array<{ id: string; settings: { reasoningEffort: string } }> => {
  if (!model.reasoning) return [];

  const direct = directReasoningEfforts(catalog, model.id).filter(
    (effort) => effort !== "none" || model.thinkingCanDisable,
  );
  const efforts =
    direct.length > 0
      ? direct
      : model.thinkingCanDisable
        ? (["none", ...FALLBACK_REASONING_EFFORTS] as const)
        : FALLBACK_REASONING_EFFORTS;
  return efforts.map((effort) => ({ id: effort, settings: { reasoningEffort: effort } }));
};

export const register9RouterCatalog = (
  catalog: CatalogDraft,
  config: RouterConfig,
  models: readonly DiscoveredModel[],
): void => {
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

  for (const discovered of models) {
    const variants = reasoningVariants(catalog, discovered);
    const transport = directModelPackage(catalog, discovered.id);
    catalog.model.update(PROVIDER_ID, discovered.id, (model) => {
      model.name = displayName(discovered.id);
      model.modelID = discovered.id as unknown as typeof model.modelID;
      model.package = transport;
      model.enabled = true;
      model.status = "active";
      model.variants = variants as unknown as typeof model.variants;
      if (discovered.contextLimit !== undefined) model.limit.context = discovered.contextLimit;
      if (discovered.outputLimit !== undefined) model.limit.output = discovered.outputLimit;
    });
  }
};

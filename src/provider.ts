import type { Plugin } from "@opencode-ai/plugin";
import type { RouterConfig } from "./config.js";
import type { DiscoveredModel } from "./discovery.js";

export const PROVIDER_ID = "9router";
export const PROVIDER_NAME = "9Router";
export const PROVIDER_PACKAGE = "aisdk:@ai-sdk/openai-compatible";

const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type CatalogDraft = Parameters<
  Parameters<Plugin.Context["catalog"]["transform"]>[0]
>[0];

export const displayName = (modelID: string): string => {
  const routeName = modelID.slice(modelID.lastIndexOf("/") + 1);
  return routeName
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => {
      if (/^[a-z]{1,3}$/u.test(part)) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
};

export const reasoningVariants = (
  model: Pick<DiscoveredModel, "reasoning" | "thinkingCanDisable">,
): Array<{ id: string; settings: { reasoningEffort: string } }> => {
  if (!model.reasoning) return [];

  const efforts = model.thinkingCanDisable
    ? (["none", ...REASONING_EFFORTS] as const)
    : REASONING_EFFORTS;
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
    catalog.model.update(PROVIDER_ID, discovered.id, (model) => {
      model.name = displayName(discovered.id);
      model.modelID = discovered.id as unknown as typeof model.modelID;
      model.package = PROVIDER_PACKAGE;
      model.enabled = true;
      model.status = "active";
      model.variants = reasoningVariants(discovered) as unknown as typeof model.variants;
    });
  }
};

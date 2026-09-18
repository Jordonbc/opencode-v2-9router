import { Plugin } from "@opencode/plugin";
import { loadConfig, type ConfigResult } from "./config.js";
import {
  discoverModels,
  isModelID,
  MAX_MODELS,
  type DiscoveredModel,
} from "./discovery.js";
import { register9RouterCatalog, MUSE_DEBUG_ROUTE } from "./provider.js";
import {
  defaultOmniRouteDeps,
  setupOmniRoute,
  type PartialOmniRouteSetupDeps,
} from "./omniroute/setup.js";

export const PLUGIN_ID = "opencode.9router";

type Dependencies = {
  readonly config: () => Promise<ConfigResult>;
  readonly discover: typeof discoverModels;
  readonly warn: (message: string) => void;
  readonly info?: (message: string) => void;
  readonly omniroute: PartialOmniRouteSetupDeps;
};

const defaults: Dependencies = {
  config: loadConfig,
  discover: discoverModels,
  warn: (message) => console.warn(message),
  info: (message) => console.info(message),
  omniroute: {},
};

type PartialDependencies = {
  readonly config?: Dependencies["config"];
  readonly discover?: Dependencies["discover"];
  readonly warn?: Dependencies["warn"];
  readonly info?: Dependencies["info"];
  readonly omniroute?: PartialOmniRouteSetupDeps;
};

const safeSink =
  (sink: ((message: string) => void) | undefined) =>
  (message: string): void => {
    try {
      sink?.(message);
    } catch {
      // Observability sinks must never break fail-soft setup.
    }
  };

const stripUndefined = <T extends Record<string, unknown>>(overrides: T): T => {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned as T;
};

const isDiscoveredModel = (value: unknown): value is DiscoveredModel => {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  const validLimit = (limit: unknown): boolean =>
    limit === undefined ||
    (typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0);
  return (
    isModelID(model.id) &&
    typeof model.reasoning === "boolean" &&
    typeof model.thinkingCanDisable === "boolean" &&
    validLimit(model.contextLimit) &&
    validLimit(model.outputLimit)
  );
};

export const createPlugin = (overrides: PartialDependencies = {}): Plugin.Plugin => {
  const dependencies: Dependencies = { ...defaults, ...stripUndefined(overrides) };
  return Plugin.define({
    id: PLUGIN_ID,
    setup: async ({ provider, integration, aisdk }) => {
      const warn = safeSink(dependencies.warn);
      const info = safeSink(dependencies.info);

      let result: ConfigResult;
      try {
        result = await dependencies.config();
      } catch {
        warn("opencode-9router-v2: invalid 9router configuration");
        return;
      }
      if (!result.ok) {
        warn(`opencode-9router-v2: ${result.error.message}`);
        return;
      }

      let models: DiscoveredModel[];
      try {
        const discovered: unknown = await dependencies.discover(result.value, {
          onTruncated: (dropped) => {
            warn(
              `opencode-9router-v2: ignoring ${dropped} model(s) beyond the ${MAX_MODELS} model limit`,
            );
          },
        });
        if (!Array.isArray(discovered) || !discovered.every(isDiscoveredModel)) {
          warn("opencode-9router-v2: model discovery failed; 9Router will be unavailable");
          return;
        }
        models = [...discovered];
      } catch {
        warn("opencode-9router-v2: model discovery failed; 9Router will be unavailable");
        return;
      }

      if (models.length === 0) {
        warn("opencode-9router-v2: /models returned no usable model IDs");
        return;
      }

      const warnedRoutes = new Set<string>();
      let registered = 0;
      let skipped = 0;
      try {
        await provider.transform((editor) => {
          const outcome = register9RouterCatalog(editor, result.value, models, {
            warn,
            warnedRoutes,
            onResolved: (resolved) => {
              if (resolved.route !== MUSE_DEBUG_ROUTE) return;
              // Temporary observability for the Muse transport issue.
              // Route, IDs, package, and counts only — never credentials.
              info(
                `opencode-9router-v2: transport route=${resolved.route} ` +
                  `provider=${resolved.providerID ?? "none"} model=${resolved.modelID} ` +
                  `package=${resolved.package} source=${resolved.packageSource} ` +
                  `candidates=${resolved.candidateCount}`,
              );
            },
          });
          registered = outcome.registered;
          skipped = outcome.skipped;
        });
      } catch {
        warn("opencode-9router-v2: failed to register 9Router models; continuing without them");
        return;
      }

      info(
        skipped > 0
          ? `opencode-9router-v2: registered ${registered} model(s) from 9Router (skipped ${skipped} model(s))`
          : `opencode-9router-v2: registered ${registered} model(s) from 9Router`,
      );

      // OmniRoute is an independent provider: its failure must never break 9Router.
      try {
        const omnirouteBase = defaultOmniRouteDeps();
        await setupOmniRoute({ provider, integration, aisdk }, {
          ...omnirouteBase,
          warn: dependencies.warn,
          info: dependencies.info,
          ...stripUndefined(dependencies.omniroute),
        });
      } catch {
        warn("opencode-9router-v2: omniroute setup failed; 9Router is unaffected");
      }
    },
  });
};

export default createPlugin();

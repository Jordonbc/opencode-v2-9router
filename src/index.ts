import { Plugin } from "@opencode-ai/plugin";
import { loadConfig, type ConfigResult } from "./config.js";
import { discoverModels, MAX_MODELS, type DiscoveredModel } from "./discovery.js";
import { register9RouterCatalog, MUSE_DEBUG_ROUTE } from "./provider.js";

export const PLUGIN_ID = "opencode.9router";

type Dependencies = {
  readonly config: () => Promise<ConfigResult>;
  readonly discover: typeof discoverModels;
  readonly warn: (message: string) => void;
  readonly info?: (message: string) => void;
};

const defaults: Dependencies = {
  config: loadConfig,
  discover: discoverModels,
  warn: (message) => console.warn(message),
  info: (message) => console.info(message),
};

type PartialDependencies = {
  readonly config?: Dependencies["config"];
  readonly discover?: Dependencies["discover"];
  readonly warn?: Dependencies["warn"];
  readonly info?: Dependencies["info"];
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

export const createPlugin = (overrides: PartialDependencies = {}): Plugin.Plugin => {
  const dependencies: Dependencies = { ...defaults, ...overrides };
  return Plugin.define({
    id: PLUGIN_ID,
    setup: async ({ catalog }) => {
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
        if (!Array.isArray(discovered)) {
          warn("opencode-9router-v2: model discovery failed; 9Router will be unavailable");
          return;
        }
        models = discovered;
      } catch {
        warn("opencode-9router-v2: model discovery failed; 9Router will be unavailable");
        return;
      }

      if (models.length === 0) {
        warn("opencode-9router-v2: /models returned no usable model IDs");
        return;
      }

      try {
        await catalog.transform((draft) => {
          register9RouterCatalog(draft, result.value, models, {
            warn,
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
        });
      } catch {
        warn("opencode-9router-v2: failed to register 9Router models; continuing without them");
        return;
      }

      info(`opencode-9router-v2: registered ${models.length} model(s) from 9Router`);
    },
  });
};

export default createPlugin();

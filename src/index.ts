import { Plugin } from "@opencode-ai/plugin";
import { loadConfig, type ConfigResult } from "./config.js";
import { discoverModels, MAX_MODELS } from "./discovery.js";
import { register9RouterCatalog } from "./provider.js";

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

export const createPlugin = (overrides: PartialDependencies = {}): Plugin.Plugin => {
  const dependencies: Dependencies = { ...defaults, ...overrides };
  return Plugin.define({
    id: PLUGIN_ID,
    setup: async ({ catalog }) => {
      let result: ConfigResult;
      try {
        result = await dependencies.config();
      } catch {
        dependencies.warn("opencode-9router-v2: invalid 9router configuration");
        return;
      }
      if (!result.ok) {
        dependencies.warn(`opencode-9router-v2: ${result.error.message}`);
        return;
      }

      let models: Awaited<ReturnType<typeof discoverModels>>;
      try {
        models = await dependencies.discover(result.value, {
          onTruncated: (dropped) => {
            dependencies.warn(
              `opencode-9router-v2: ignoring ${dropped} model(s) beyond the ${MAX_MODELS} model limit`,
            );
          },
        });
      } catch {
        dependencies.warn("opencode-9router-v2: model discovery failed; 9Router will be unavailable");
        return;
      }

      if (models.length === 0) {
        dependencies.warn("opencode-9router-v2: /models returned no usable model IDs");
        return;
      }

      try {
        await catalog.transform((draft) => {
          register9RouterCatalog(draft, result.value, models);
        });
      } catch {
        dependencies.warn("opencode-9router-v2: failed to register 9Router models; continuing without them");
        return;
      }

      try {
        dependencies.info?.(`opencode-9router-v2: registered ${models.length} model(s) from 9Router`);
      } catch {
        // The info sink is optional observability; it must not break fail-soft setup.
      }
    },
  });
};

export default createPlugin();

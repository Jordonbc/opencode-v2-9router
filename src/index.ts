import { Plugin } from "@opencode-ai/plugin";
import { loadConfig, type ConfigResult } from "./config.js";
import { discoverModels } from "./discovery.js";
import { register9RouterCatalog } from "./provider.js";

export const PLUGIN_ID = "opencode.9router";

type Dependencies = {
  readonly config: () => Promise<ConfigResult>;
  readonly discover: typeof discoverModels;
  readonly warn: (message: string) => void;
};

const defaults: Dependencies = {
  config: loadConfig,
  discover: discoverModels,
  warn: (message) => console.warn(message),
};

export const createPlugin = (dependencies: Dependencies = defaults): Plugin.Plugin =>
  Plugin.define({
    id: PLUGIN_ID,
    setup: async ({ catalog }) => {
      const result = await dependencies.config();
      if (!result.ok) {
        dependencies.warn(`opencode-9router-v2: ${result.error.message}`);
        return;
      }

      let models: Awaited<ReturnType<typeof discoverModels>>;
      try {
        models = await dependencies.discover(result.value);
      } catch {
        dependencies.warn("opencode-9router-v2: model discovery failed; 9Router will be unavailable");
        return;
      }

      if (models.length === 0) {
        dependencies.warn("opencode-9router-v2: /models returned no usable model IDs");
        return;
      }

      await catalog.transform((draft) => {
        register9RouterCatalog(draft, result.value, models);
      });
    },
  });

export default createPlugin();

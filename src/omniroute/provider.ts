import type { Model, Provider } from "@opencode/plugin";
import type { ProviderEditor } from "../provider.js";
import { OMNIROUTE_OPENAI_PACKAGE } from "./catalog.js";

export type OmniRouteRegisterResult = {
  readonly registered: number;
  readonly skipped: number;
};

const safeWarn = (warn: ((message: string) => void) | undefined, message: string): void => {
  try {
    warn?.(message);
  } catch {
    // Observability must never break catalog registration.
  }
};

/**
 * Publish one provider (`providerID`) with its own inventory and gateway
 * credentials. Inference always targets the configured gateway; per-model
 * `package` values only select the request/response dialect.
 */
export const registerOmniRouteCatalog = (
  editor: ProviderEditor,
  input: {
    readonly providerID: string;
    readonly displayName: string;
    readonly apiKey: string;
    readonly baseURL: string;
    readonly models: readonly Model.Info[];
  },
  options: { readonly warn?: (message: string) => void } = {},
): OmniRouteRegisterResult => {
  if (editor.get(input.providerID) === undefined) {
    editor.add({
      info: {
        id: input.providerID,
        name: input.displayName,
        activation: "enabled",
        package: OMNIROUTE_OPENAI_PACKAGE,
        settings: { apiKey: input.apiKey, baseURL: input.baseURL },
      } as unknown as Provider.Info,
      models: [],
    });
  } else {
    editor.update(input.providerID, (provider) => {
      provider.name = input.displayName;
      provider.package = OMNIROUTE_OPENAI_PACKAGE;
      provider.activation = "enabled";
      provider.settings = {
        ...(typeof provider.settings === "object" && provider.settings !== null
          ? provider.settings
          : {}),
        apiKey: input.apiKey,
        baseURL: input.baseURL,
      };
    });
  }

  let registered = 0;
  let skipped = 0;
  const infos: Model.Info[] = [];
  for (const model of input.models) {
    try {
      if (!model || typeof (model as { id?: unknown }).id !== "string") {
        throw new Error("invalid model entry");
      }
      infos.push(model);
    } catch {
      skipped += 1;
    }
  }

  if (infos.length > 0) {
    try {
      editor.models.set(input.providerID, infos);
      registered += infos.length;
    } catch {
      skipped += infos.length;
    }
  }

  if (skipped > 0) {
    safeWarn(
      options.warn,
      `opencode-9router-v2: omniroute skipped ${skipped} model(s) that failed to register`,
    );
  }
  return { registered, skipped };
};

import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError } from "../src/config.js";
import { createPlugin, PLUGIN_ID } from "../src/index.js";

test("exports a native V2 default definition", async () => {
  const plugin = createPlugin({
    config: async () => ({
      ok: true,
      value: { apiKey: "secret-key", baseURL: "http://router.test/v1" },
    }),
    discover: async () => ["ocg/muse-spark-1.3-contributor"],
    warn: () => undefined,
  });

  assert.equal(plugin.id, PLUGIN_ID);
  assert.equal(typeof plugin.setup, "function");
});

test("offline discovery emits one safe warning and does not register", async () => {
  const warnings: string[] = [];
  let transforms = 0;
  const secret = "never-log-this-key";
  const plugin = createPlugin({
    config: async () => ({
      ok: true,
      value: { apiKey: secret, baseURL: "http://router.test/v1" },
    }),
    discover: async () => {
      throw new Error(`network error containing ${secret}`);
    },
    warn: (message) => warnings.push(message),
  });

  await plugin.setup({
    catalog: {
      transform: async () => {
        transforms += 1;
        return { dispose: async () => undefined };
      },
    },
  } as never);

  assert.equal(transforms, 0);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0] ?? "", new RegExp(secret, "u"));
});

test("missing configuration warns without failing plugin setup", async () => {
  const warnings: string[] = [];
  const plugin = createPlugin({
    config: async () => ({
      ok: false,
      error: new ConfigError("OPENCODE_9ROUTER_API_KEY is not configured"),
    }),
    discover: async () => {
      throw new Error("should not run");
    },
    warn: (message) => warnings.push(message),
  });

  await plugin.setup({} as never);
  assert.deepEqual(warnings, [
    "opencode-9router-v2: OPENCODE_9ROUTER_API_KEY is not configured",
  ]);
});

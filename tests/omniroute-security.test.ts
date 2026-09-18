import assert from "node:assert/strict";
import test from "node:test";
import { readConnectionKey, resolveKeychain } from "../src/omniroute/credentials.js";
import {
  isGeminiModelID,
  sanitizeToolInputSchemas,
  wrapLanguageModelForGemini,
} from "../src/omniroute/gemini.js";

test("prefers stored credentials over environment keys with compat fallbacks", () => {
  assert.deepEqual(
    resolveKeychain({
      stored: "stored",
      environment: { OPENCODE_OMNIROUTE_API_KEY: "env", OMNIROUTE_API_KEY: "compat" },
    }),
    { apiKey: "stored", managementKey: undefined },
  );
  assert.deepEqual(
    resolveKeychain({
      environment: {
        OPENCODE_OMNIROUTE_API_KEY: "env",
        OMNIROUTE_API_KEY: "compat",
        OPENCODE_OMNIROUTE_MANAGEMENT_API_KEY: "mgmt",
        OMNIROUTE_MANAGEMENT_API_KEY: "compat-mgmt",
      },
    }),
    { apiKey: "env", managementKey: "mgmt" },
  );
  assert.deepEqual(
    resolveKeychain({
      environment: { OMNIROUTE_API_KEY: "compat", OMNIROUTE_MANAGEMENT_API_KEY: "cm" },
    }),
    { apiKey: "compat", managementKey: "cm" },
  );
  assert.deepEqual(resolveKeychain({ environment: {} }), { apiKey: "", managementKey: undefined });
  assert.deepEqual(
    resolveKeychain({ stored: "", environment: { OPENCODE_OMNIROUTE_API_KEY: "env" } }),
    { apiKey: "env", managementKey: undefined },
  );
});

test("reads the stored OpenCode credential without ever throwing", async () => {
  const context = {
    integration: {
      connection: {
        active: async () => ({ id: "c1" }),
        resolve: async () => ({ type: "key", key: "stored-key" }),
      },
    },
  };
  assert.equal(await readConnectionKey(context, "omniroute"), "stored-key");
  assert.equal(await readConnectionKey({}, "omniroute"), undefined);
  assert.equal(await readConnectionKey({ integration: {} }, "omniroute"), undefined);
  assert.equal(
    await readConnectionKey(
      {
        integration: {
          connection: {
            active: async () => undefined,
            resolve: async () => {
              throw new Error("must not run");
            },
          },
        },
      },
      "omniroute",
    ),
    undefined,
  );
  const warnings: string[] = [];
  assert.equal(
    await readConnectionKey(
      {
        integration: {
          connection: {
            active: async () => ({ id: "c1" }),
            resolve: async () => ({ type: "oauth", access: "x" }),
          },
        },
      },
      "omniroute",
      (message) => warnings.push(message),
    ),
    undefined,
  );
  assert.equal(warnings.length, 1);
  assert.equal(
    await readConnectionKey(
      {
        integration: {
          connection: {
            active: async () => {
              throw new Error("host blew up");
            },
            resolve: async () => undefined,
          },
        },
      },
      "omniroute",
    ),
    undefined,
  );
  assert.equal(
    await readConnectionKey({ integration: { connection: {} } }, "omniroute"),
    undefined,
  );
  assert.equal(
    await readConnectionKey(
      { integration: { connection: { active: async () => ({ id: "c1" }) } } },
      "omniroute",
    ),
    undefined,
  );
  assert.equal(
    await readConnectionKey(
      {
        integration: {
          connection: {
            active: async () => ({ id: "c1" }),
            resolve: async () => {
              throw new Error("resolve blew up");
            },
          },
        },
      },
      "omniroute",
    ),
    undefined,
  );
  const noisy: string[] = [];
  assert.equal(
    await readConnectionKey(
      {
        integration: {
          connection: {
            active: async () => ({ id: "c1" }),
            resolve: async () => ({ type: "oauth" }),
          },
        },
      },
      "omniroute",
      () => {
        throw new Error("sink blew up");
      },
    ),
    undefined,
  );
  assert.deepEqual(noisy, []);
});

test("treats blank primary keys as absent", () => {
  assert.deepEqual(
    resolveKeychain({
      environment: { OPENCODE_OMNIROUTE_API_KEY: "", OMNIROUTE_API_KEY: "compat" },
    }),
    { apiKey: "compat", managementKey: undefined },
  );
});

test("rejects empty stored keys", async () => {
  assert.equal(
    await readConnectionKey(
      {
        integration: {
          connection: {
            active: async () => ({ id: "c1" }),
            resolve: async () => ({ type: "key", key: "" }),
          },
        },
      },
      "omniroute",
    ),
    undefined,
  );
});

test("detects Gemini-routed model ids across bare, canonical and prefixed forms", () => {
  for (const id of [
    "gemini",
    "gemini-2.5-flash",
    "gemini-1.5-pro",
    "models/gemini-1.5-pro",
    "google/gemini-2.0-flash",
    "cc/gemini-2.5-pro",
    "GEMINI-EXP",
  ]) {
    assert.equal(isGeminiModelID(id), true, id);
  }
  for (const id of ["cc/claude-opus", "gpt-4o", "gemini-compatible-proxy", "my-gemini-wrapper", "", 42, undefined]) {
    assert.equal(isGeminiModelID(id), false, String(id));
  }
});

test("strips rejected schema keywords deeply but keeps everything else", () => {
  const tools = [
    {
      name: "read",
      inputSchema: {
        type: "object",
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
        properties: {
          path: { type: "string", additionalProperties: true },
          additionalProperties: { type: "string" },
        },
        items: [{ type: "string", $schema: "x" }],
        anyOf: [{ type: "number", additionalProperties: false }],
      },
    },
  ];
  const cleaned = sanitizeToolInputSchemas(tools);
  assert.ok(cleaned);
  assert.notEqual(cleaned, tools);
  assert.deepEqual(cleaned?.[0]?.inputSchema, {
    type: "object",
    properties: {
      path: { type: "string" },
      additionalProperties: { type: "string" },
    },
    items: [{ type: "string" }],
    anyOf: [{ type: "number" }],
  });
  // Originals are never mutated.
  assert.equal((tools[0]?.inputSchema as Record<string, unknown>).$schema, "http://json-schema.org/draft-07/schema#");
});

test("forwards $ref tools and unreadable schemas untouched", () => {
  const withRef = [{ name: "a", inputSchema: { $ref: "#/$defs/x", additionalProperties: false } }];
  assert.equal(sanitizeToolInputSchemas(withRef), undefined);
  const nestedRef = [
    { name: "b", inputSchema: { properties: { x: { $ref: "#/y" } }, additionalProperties: false } },
  ];
  assert.equal(sanitizeToolInputSchemas(nestedRef), undefined);
  assert.equal(sanitizeToolInputSchemas([]), undefined);
  assert.equal(sanitizeToolInputSchemas(undefined), undefined);
  assert.equal(sanitizeToolInputSchemas([{ name: "c" }])?.length ?? 0, 0);
  const clean = [{ name: "d", inputSchema: { type: "string" } }];
  assert.equal(sanitizeToolInputSchemas(clean), undefined);
  // Unreadable schemas pass through untouched.
  const opaque = [{ name: "e", inputSchema: "just-a-string" }];
  assert.equal(sanitizeToolInputSchemas(opaque), undefined);
  const uncloneable = [{ name: "f", inputSchema: { nested: { fn: () => 1 } } }];
  assert.equal(sanitizeToolInputSchemas(uncloneable), undefined);
  // Tuple items and non-schema children are walked safely.
  const tupleRef = [
    { name: "g", inputSchema: { items: [{ $ref: "#/a" }], additionalProperties: false } },
  ];
  assert.equal(sanitizeToolInputSchemas(tupleRef), undefined);
  const primitiveChild = [
    { name: "h", inputSchema: { items: "x", properties: "y", additionalProperties: false } },
  ];
  const cleanedPrimitive = sanitizeToolInputSchemas(primitiveChild);
  assert.deepEqual(cleanedPrimitive?.[0]?.inputSchema, { items: "x", properties: "y" });
  // Nested-only keywords still flip the result through the recursion.
  const nestedOnly = [
    { name: "i", inputSchema: { properties: { x: { additionalProperties: false } } } },
  ];
  assert.deepEqual(sanitizeToolInputSchemas(nestedOnly)?.[0]?.inputSchema, {
    properties: { x: {} },
  });
  // Record-valued schema positions recurse directly.
  const recordChild = [
    { name: "j", inputSchema: { items: { type: "string", additionalProperties: false } } },
  ];
  assert.deepEqual(sanitizeToolInputSchemas(recordChild)?.[0]?.inputSchema, {
    items: { type: "string" },
  });
});

test("wraps only Gemini language models", () => {
  const calls: unknown[][] = [];
  const language = {
    name: "test-model",
    doGenerate: (options: unknown) => {
      calls.push(["generate", options]);
      return "generated";
    },
    doStream: (options: unknown) => {
      calls.push(["stream", options]);
      return "streamed";
    },
  };
  assert.equal(wrapLanguageModelForGemini(undefined, "google/gemini-2.0-flash"), undefined);
  const passthrough = wrapLanguageModelForGemini(language, "cc/claude-opus");
  assert.equal(passthrough, language);

  const wrapped = wrapLanguageModelForGemini(language, "google/gemini-2.0-flash");
  assert.ok(wrapped && wrapped !== language);
  assert.equal((wrapped as typeof language).name, "test-model");
  const tools = [{ name: "t", inputSchema: { type: "object", additionalProperties: false } }];
  assert.equal((wrapped as typeof language).doGenerate({ tools }), "generated");
  assert.equal((wrapped as typeof language).doStream({ tools }), "streamed");
  assert.deepEqual((calls[0]?.[1] as { tools: unknown[] }).tools, [
    { name: "t", inputSchema: { type: "object" } },
  ]);
  // Clean requests pass through unchanged.
  calls.length = 0;
  (wrapped as typeof language).doGenerate({ prompt: "hi" });
  assert.deepEqual(calls[0]?.[1], { prompt: "hi" });
});

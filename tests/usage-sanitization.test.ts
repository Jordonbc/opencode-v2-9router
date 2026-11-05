import assert from "node:assert/strict";
import test from "node:test";
import { wrapLanguageModelForUsageSanitization } from "../src/omniroute/gemini.js";

test("strips opencode from finish usage", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "finish", usage: { inputTokens: 1, opencode: { billing_source: "go-plus" } } });
      controller.close();
    },
  });
  const model: any = {
    doGenerate: async () => ({ usage: { outputTokens: 2, opencode: { billing_source: "go-plus" } } }),
    doStream: async () => ({ stream }),
  };
  const wrapped: any = wrapLanguageModelForUsageSanitization(model, "opencode-go/beam-free");
  const gen = await wrapped.doGenerate({});
  assert.deepEqual(gen.usage, { outputTokens: 2 });
  const res = await wrapped.doStream({});
  const reader = res.stream.getReader();
  const { value } = await reader.read();
  assert.deepEqual(value.usage, { inputTokens: 1 });
});

test("passes through non-affected models", () => {
  const model: any = { doGenerate: async () => ({}), doStream: async () => ({}) };
  const wrapped = wrapLanguageModelForUsageSanitization(model, "openai/gpt-4");
  assert.equal(wrapped, model);
});

test("handles missing stream", async () => {
  const model: any = {
    doGenerate: async () => ({}),
    doStream: async () => ({ foo: 1 }),
  };
  const wrapped: any = wrapLanguageModelForUsageSanitization(model, "opencode-go/beam-free");
  const res = await wrapped.doStream({});
  assert.equal(res.foo, 1);
});
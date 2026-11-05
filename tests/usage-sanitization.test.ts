import assert from "node:assert/strict";
import test from "node:test";
import { wrapLanguageModelForUsageSanitization } from "../src/omniroute/gemini.js";

test("strips opencode from providerMetadata", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue({
        type: "finish",
        usage: {
          inputTokens: 1,
          providerMetadata: { omniroute: { opencode: { billing_source: "go-plus" }, other: 2 } },
        },
      });
      controller.close();
    },
  });
  const model: any = {
    doGenerate: async () => ({ usage: { outputTokens: 2, providerMetadata: { omniroute: { opencode: { billing_source: "go-plus" } } } } }),
    doStream: async () => ({ stream }),
  };
  const wrapped: any = wrapLanguageModelForUsageSanitization(model, "opencode-go/beam-free");
  const gen = await wrapped.doGenerate({});
  assert.deepEqual(gen.usage.providerMetadata.omniroute, {});
  const res = await wrapped.doStream({});
  const reader = res.stream.getReader();
  const { value } = await reader.read();
  assert.deepEqual(value.usage.providerMetadata.omniroute, { other: 2 });
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

test("handles non-finish stream parts", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-delta", text: "hi" });
      controller.close();
    },
  });
  const model: any = {
    doGenerate: async () => ({}),
    doStream: async () => ({ stream }),
  };
  const wrapped: any = wrapLanguageModelForUsageSanitization(model, "opencode-go/beam-free");
  const res = await wrapped.doStream({});
  const reader = res.stream.getReader();
  const { value } = await reader.read();
  assert.equal(value.type, "text-delta");
});

test("handles undefined usage", async () => {
  const model: any = {
    doGenerate: async () => ({ usage: undefined }),
    doStream: async () => ({ stream: new ReadableStream({ start(c) { c.close(); } }) }),
  };
  const wrapped: any = wrapLanguageModelForUsageSanitization(model, "opencode-go/beam-free");
  const gen = await wrapped.doGenerate({});
  assert.equal(gen.usage, undefined);
});

test("handles providerMetadata object without opencode", async () => {
  const model: any = {
    doGenerate: async () => ({ usage: { providerMetadata: { omniroute: { other: 2 } }, inputTokens: 1 } }),
    doStream: async () => ({ stream: new ReadableStream({ start(c) { c.close(); } }) }),
  };
  const wrapped: any = wrapLanguageModelForUsageSanitization(model, "opencode-go/beam-free");
  const gen = await wrapped.doGenerate({});
  assert.deepEqual(gen.usage.providerMetadata, { omniroute: { other: 2 } });
});

test("handles non-object providerMetadata entries", async () => {
  const model: any = {
    doGenerate: async () => ({ usage: { providerMetadata: { omniroute: 5 }, inputTokens: 1 } }),
    doStream: async () => ({ stream: new ReadableStream({ start(c) { c.close(); } }) }),
  };
  const wrapped: any = wrapLanguageModelForUsageSanitization(model, "opencode-go/beam-free");
  const gen = await wrapped.doGenerate({});
  assert.deepEqual(gen.usage.providerMetadata, { omniroute: 5 });
});

test("works without diagnostic", async () => {
  const model: any = {
    doGenerate: async () => ({ usage: { inputTokens: 1, opencode: { billing_source: "go-plus" } } }),
    doStream: async () => ({ stream: new ReadableStream({ start(c) { c.close(); } }) }),
  };
  const wrapped: any = wrapLanguageModelForUsageSanitization(model, "opencode-go/beam-free");
  const gen = await wrapped.doGenerate({});
  assert.deepEqual(gen.usage, { inputTokens: 1 });
});

test("returns undefined language untouched", () => {
  const wrapped = wrapLanguageModelForUsageSanitization(undefined, "opencode-go/beam-free");
  assert.equal(wrapped, undefined);
});

test("logs diagnostic when removing", async () => {
  const messages: string[] = [];
  const model: any = {
    doGenerate: async () => ({ usage: { providerMetadata: { omniroute: { opencode: { billing_source: "go-plus" } } } } }),
    doStream: async () => ({ stream: new ReadableStream({ start(c) { c.close(); } }) }),
  };
  const wrapped: any = wrapLanguageModelForUsageSanitization(model, "opencode-go/beam-free", (m) => messages.push(m));
  await wrapped.doGenerate({});
  assert.ok(messages.some((m) => m.includes("removed opencode")));
});

test("strips top-level opencode", async () => {
  const model: any = {
    doGenerate: async () => ({ usage: { opencode: { billing_source: "go-plus" }, inputTokens: 1 } }),
    doStream: async () => ({ stream: new ReadableStream({ start(c) { c.close(); } }) }),
  };
  const wrapped: any = wrapLanguageModelForUsageSanitization(model, "opencode-go/beam-free");
  const gen = await wrapped.doGenerate({});
  assert.deepEqual(gen.usage, { inputTokens: 1 });
});
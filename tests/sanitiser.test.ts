import assert from "node:assert/strict";
import test from "node:test";
import { createSseSanitizer, sanitizeSse } from "../src/sanitiser.js";

test("removes usage.opencode from a usage-only event", () => {
  const input = 'data: {"id":"1","choices":[],"usage":{"prompt_tokens":5,"opencode":{"billing_source":"go-plus"}}}\n\n';
  const expected = 'data: {"id":"1","choices":[],"usage":{"prompt_tokens":5}}\n\n';
  assert.equal(sanitizeSse(input), expected);
});

test("preserves fragmented SSE events across chunks", () => {
  const sanitizer = createSseSanitizer();
  const event = 'data: {"id":"2","choices":[],"usage":{"prompt_tokens":1,"opencode":{"billing_source":"go-plus"}}}\n\n';
  const partA = event.slice(0, 17);
  const partB = event.slice(17);
  const out = sanitizer.transform(partA) + sanitizer.transform(partB) + sanitizer.flush();
  assert.equal(out, 'data: {"id":"2","choices":[],"usage":{"prompt_tokens":1}}\n\n');
});

test("handles multiple events in one chunk", () => {
  const input =
    'data: {"id":"a","choices":[],"usage":{"opencode":{"billing_source":"go-plus"},"x":1}}\n\n' +
    'data: {"id":"b","choices":[],"usage":{"y":2}}\n\n';
  const expected =
    'data: {"id":"a","choices":[],"usage":{"x":1}}\n\n' +
    'data: {"id":"b","choices":[],"usage":{"y":2}}\n\n';
  assert.equal(sanitizeSse(input), expected);
});

test("leaves normal usage events unchanged", () => {
  const input = 'data: {"id":"n","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n';
  assert.equal(sanitizeSse(input), input);
});

test("does not strip go-plus from assistant text", () => {
  const input = 'data: {"id":"t","choices":[{"delta":{"content":"go-plus"}}]}\n\n';
  assert.equal(sanitizeSse(input), input);
});

test("preserves reasoning and tool calls", () => {
  const input =
    'data: {"id":"r","choices":[{"delta":{"reasoning_content":"think","tool_calls":[{"id":"1","function":{"name":"ls","arguments":"{}"}}]}}]}\n\n';
  assert.equal(sanitizeSse(input), input);
});

test("preserves [DONE]", () => {
  const input = "data: [DONE]\n\n";
  assert.equal(sanitizeSse(input), input);
});

test("leaves error events unchanged", () => {
  const input = 'data: {"error":{"message":"boom","opencode":{"billing_source":"go-plus"}}}\n\n';
  assert.equal(sanitizeSse(input), input);
});

test("leaves events with choices and usage.opencode unchanged", () => {
  const input = 'data: {"id":"c","choices":[{"delta":{"content":"hi"}}],"usage":{"opencode":{"billing_source":"go-plus"}}}\n\n';
  assert.equal(sanitizeSse(input), input);
});

test("handles trailing partial event on flush", () => {
  const sanitizer = createSseSanitizer();
  const event = 'data: {"choices":[],"usage":{"opencode":{"billing_source":"go-plus"},"z":9}}';
  const out = sanitizer.transform(event) + sanitizer.flush();
  assert.equal(out, 'data: {"choices":[],"usage":{"z":9}}');
});
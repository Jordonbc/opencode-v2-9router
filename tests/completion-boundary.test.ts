import assert from "node:assert/strict";
import test from "node:test";
import { createCompletionBoundary } from "../src/omniroute/completion-boundary.js";

const frame = (choices: unknown[], extra = {}) => `data: ${JSON.stringify({ choices, ...extra })}\n\n`;
const choice = (delta: unknown, finish_reason: unknown = null, index = 0) => ({ index, delta, finish_reason });
const run = (input: string, width = input.length) => {
  const boundary = createCompletionBoundary();
  let out = "";
  for (let i = 0; i < input.length; i += width) out += boundary.transform(input.slice(i, i + width));
  return out + boundary.flush();
};

test("terminal choice rejects late content and refusal, retaining usage and DONE", () => {
  const before = frame([choice({ content: "Hello go-plus" })]) + frame([choice({}, "stop")]);
  const usage = frame([], { usage: { prompt_tokens: 10, opencode: { billing_source: "go-plus" } } });
  const late = frame([choice({ content: "go-plus", refusal: "go-plus", reasoning_content: "kept" })]);
  const expected = before + usage + frame([choice({ reasoning_content: "kept" })]) + "data: [DONE]\n\n";
  const input = before + usage + late + "data: [DONE]\n\n";
  for (const width of [1, 2, 7, input.length]) assert.equal(run(input, width), expected);
});

test("accepts genuine text and refusal before finish and text on the finish event", () => {
  const input = frame([choice({ content: "go-plus", refusal: "a genuine refusal" })]) + frame([choice({ content: " go-plus" }, "stop")]);
  assert.equal(run(input), input);
});

test("tracks choices separately and preserves non-text fields and token counts", () => {
  const before = frame([choice({}, "tool_calls", 0)]);
  const late = frame([choice({ content: "late", tool_calls: [{ index: 0 }] }, null, 0), choice({ content: "go-plus" }, null, 1)], { usage: { completion_tokens: 5 } });
  const expected = before + frame([choice({ tool_calls: [{ index: 0 }] }, null, 0), choice({ content: "go-plus" }, null, 1)], { usage: { completion_tokens: 5 } });
  assert.equal(run(before + late), expected);
});

test("preserves empty deltas, invalid JSON, malformed shapes, comments, and CRLF", () => {
  const input = ': comment\r\ndata: nope\r\n\r\ndata: null\n\ndata: {}\n\n' + frame([null, 1, { index: "0" }, choice({}, ""), choice({}, 1)]) + frame([choice({}, "stop")]) + frame([choice(null), choice([], null), choice({ content: "", refusal: 42 })]);
  assert.equal(run(input, 1), input);
  assert.equal(run(input.replaceAll('\n\n', '\r\r'), 2), input.replaceAll('\n\n', '\r\r'));
});

test("flush handles unterminated frames and does not leak state to another response", () => {
  const input = frame([choice({}, "stop")]) + frame([choice({ content: "late" })]).trimEnd();
  assert.equal(run(input), frame([choice({}, "stop")]) + frame([choice({})]).trimEnd());
  const boundary = createCompletionBoundary();
  assert.equal(boundary.flush(), "");
  const fresh = frame([choice({ content: "go-plus" })]);
  assert.equal(run(fresh), fresh);
});

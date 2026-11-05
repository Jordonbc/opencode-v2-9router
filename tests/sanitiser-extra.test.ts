import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSse } from "../src/sanitiser.js";

test("CRLF separator", () => {
  const input = 'data: {"choices":[],"usage":{"prompt_tokens":1,"opencode":{"billing_source":"go-plus"}}}\r\n\r\n';
  const expected = 'data: {"choices":[],"usage":{"prompt_tokens":1}}\r\n\r\n';
  assert.equal(sanitizeSse(input), expected);
});

test("escaped quotes in strings", () => {
  const input = 'data: {"choices":[],"usage":{"msg":"a\\"b","prompt_tokens":1,"opencode":{"billing_source":"go-plus"}}}\n\n';
  const expected = 'data: {"choices":[],"usage":{"msg":"a\\"b","prompt_tokens":1}}\n\n';
  assert.equal(sanitizeSse(input), expected);
});

test("opencode as only usage property", () => {
  const input = 'data: {"choices":[],"usage":{"opencode":{"billing_source":"go-plus"}}}\n\n';
  const expected = 'data: {"choices":[],"usage":{}}\n\n';
  assert.equal(sanitizeSse(input), expected);
});

test("invalid JSON event unchanged", () => {
  const input = "data: {bad json}\n\n";
  assert.equal(sanitizeSse(input), input);
});

test("non-data line unchanged", () => {
  const input = "event: ping\n\ndata: {\"choices\":[],\"usage\":{\"opencode\":{\"billing_source\":\"go-plus\"}}}\n\n";
  const expected = "event: ping\n\ndata: {\"choices\":[],\"usage\":{}}\n\n";
  assert.equal(sanitizeSse(input), expected);
});

test("opencode first followed by comma", () => {
  const input = 'data: {"choices":[],"usage":{"opencode":{"billing_source":"go-plus"},"z":9}}\n\n';
  const expected = 'data: {"choices":[],"usage":{"z":9}}\n\n';
  assert.equal(sanitizeSse(input), expected);
});
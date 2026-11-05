import assert from "node:assert/strict";
import test from "node:test";
import { SseSanitizer, sanitizeSseChunk, createSseSanitizer } from "../src/sanitiser.js";

test("class and chunk alias", () => {
  const instance = new SseSanitizer();
  const chunk = 'data: {"choices":[],"usage":{"opencode":{"billing_source":"go-plus"},"a":1}}\n\n';
  const out = instance.transform(chunk) + instance.flush();
  assert.equal(out, 'data: {"choices":[],"usage":{"a":1}}\n\n');
  const other = createSseSanitizer();
  assert.equal(sanitizeSseChunk(chunk, other), 'data: {"choices":[],"usage":{"a":1}}\n\n');
});
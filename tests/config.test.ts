import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, normalizeBaseURL, parseEnvironmentFile } from "../src/config.js";

test("normalizes a /v1 base URL", () => {
  assert.equal(normalizeBaseURL(" HTTP://10.0.0.1:20128/v1/// "), "http://10.0.0.1:20128/v1");
  assert.throws(() => normalizeBaseURL("file:///tmp/v1"), /http or https/u);
  assert.throws(() => normalizeBaseURL("https://example.com/api"), /end with \/v1/u);
  assert.throws(() => normalizeBaseURL("https://user:pass@example.com/v1"), /must not contain/u);
});

test("parses only supported environment-file assignments", () => {
  assert.deepEqual(
    parseEnvironmentFile(`
      # ignored
      OPENCODE_9ROUTER_URL="http://nas:20128/v1"
      export OPENCODE_9ROUTER_API_KEY='secret'
      UNRELATED=value
    `),
    {
      OPENCODE_9ROUTER_URL: "http://nas:20128/v1",
      OPENCODE_9ROUTER_API_KEY: "secret",
    },
  );
});

test("environment variables take precedence over the fallback file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-9router-config-"));
  const fallbackPath = join(directory, "9router.conf");
  await writeFile(
    fallbackPath,
    "OPENCODE_9ROUTER_URL=http://file:20128/v1\nOPENCODE_9ROUTER_API_KEY=file-key\n",
  );

  const result = await loadConfig(
    {
      OPENCODE_9ROUTER_URL: "http://environment:20128/v1",
      OPENCODE_9ROUTER_API_KEY: "environment-key",
    },
    fallbackPath,
  );

  assert.deepEqual(result, {
    ok: true,
    value: {
      apiKey: "environment-key",
      baseURL: "http://environment:20128/v1",
    },
  });
});

test("reports a missing API key without exposing configuration values", async () => {
  const result = await loadConfig(
    { OPENCODE_9ROUTER_URL: "http://10.0.0.1:20128/v1" },
    join(tmpdir(), "definitely-missing-9router.conf"),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /API_KEY is not configured/u);
    assert.doesNotMatch(result.error.message, /10\.0\.0\.1/u);
  }
});

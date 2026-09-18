import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_ANTHROPIC_PREFIXES,
  DEFAULT_AUTO_COMBOS_TIMEOUT_MS,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_DISPLAY_NAME,
  DEFAULT_PROVIDER_ID,
  DEFAULT_TIMEOUT_MS,
  isProviderID,
  loadOmniRouteConfig,
  normalizeGatewayRoot,
  OmniRouteConfigError,
  parseOmniRouteEnvironmentFile,
} from "../src/omniroute/config.js";

test("disabled when the URL is absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omniroute-disabled-"));
  const result = await loadOmniRouteConfig({}, join(directory, "missing.conf"));
  assert.deepEqual(result, { ok: true, value: undefined });
});

test("loads a valid URL with tolerated /v1 suffix", async () => {
  for (const url of ["http://127.0.0.1:20128", "http://127.0.0.1:20128/v1", "http://127.0.0.1:20128/v1/"]) {
    const result = await loadOmniRouteConfig(
      { OPENCODE_OMNIROUTE_URL: url, OPENCODE_OMNIROUTE_API_KEY: "k" },
      join(tmpdir(), "definitely-missing-omniroute.conf"),
    );
    assert.equal(result.ok, true);
    if (result.ok && result.value) {
      assert.equal(result.value.gatewayRoot, "http://127.0.0.1:20128");
      assert.equal(result.value.baseURL, "http://127.0.0.1:20128/v1");
    } else {
      assert.fail("expected an enabled config");
    }
  }
});

test("rejects invalid URLs with safe errors", async () => {
  const secret = "never-log-this-key";
  for (const url of [
    "not a url",
    "ftp://example.com/v1",
    "https://user:pass@example.com/",
    "https://example.com/v1?key=x",
    "https://example.com/v1?#",
    "https://example.com/v1#",
    "https://example.com/#frag",
  ]) {
    const result = await loadOmniRouteConfig(
      { OPENCODE_OMNIROUTE_URL: url, OPENCODE_OMNIROUTE_API_KEY: secret },
      join(tmpdir(), "definitely-missing-omniroute.conf"),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error instanceof OmniRouteConfigError);
      assert.doesNotMatch(result.error.message, new RegExp(secret, "u"));
    }
  }
});

test("supports inference and management credentials with compat fallbacks", async () => {
  const base = { OPENCODE_OMNIROUTE_URL: "http://gw:20128" };
  const primary = await loadOmniRouteConfig(
    { ...base, OPENCODE_OMNIROUTE_API_KEY: "a", OPENCODE_OMNIROUTE_MANAGEMENT_API_KEY: "m" },
    join(tmpdir(), "definitely-missing-omniroute.conf"),
  );
  assert.equal(primary.ok, true);
  if (primary.ok && primary.value) {
    assert.equal(primary.value.apiKey, "a");
    assert.equal(primary.value.managementKey, "m");
  }

  const compat = await loadOmniRouteConfig(
    { ...base, OMNIROUTE_API_KEY: "ca", OMNIROUTE_MANAGEMENT_API_KEY: "cm" },
    join(tmpdir(), "definitely-missing-omniroute.conf"),
  );
  assert.equal(compat.ok, true);
  if (compat.ok && compat.value) {
    assert.equal(compat.value.apiKey, "ca");
    assert.equal(compat.value.managementKey, "cm");
  }

  // Primary wins over compat.
  const both = await loadOmniRouteConfig(
    { ...base, OPENCODE_OMNIROUTE_API_KEY: "a", OMNIROUTE_API_KEY: "ca" },
    join(tmpdir(), "definitely-missing-omniroute.conf"),
  );
  assert.equal(both.ok, true);
  if (both.ok && both.value) assert.equal(both.value.apiKey, "a");

  // Missing keys are allowed here (OpenCode stored credential may supply them).
  const nokeys = await loadOmniRouteConfig(base, join(tmpdir(), "definitely-missing-omniroute.conf"));
  assert.equal(nokeys.ok, true);
  if (nokeys.ok && nokeys.value) {
    assert.equal(nokeys.value.apiKey, "");
    assert.equal(nokeys.value.managementKey, undefined);
  }
});

test("applies defaults for identity, timeouts, cache, flags and anthropic settings", async () => {
  const result = await loadOmniRouteConfig(
    { OPENCODE_OMNIROUTE_URL: "http://gw:20128", OPENCODE_OMNIROUTE_API_KEY: "k" },
    join(tmpdir(), "definitely-missing-omniroute.conf"),
  );
  assert.equal(result.ok, true);
  if (!result.ok || !result.value) assert.fail("expected config");
  else {
    assert.equal(result.value.providerID, DEFAULT_PROVIDER_ID);
    assert.equal(result.value.displayName, DEFAULT_DISPLAY_NAME);
    assert.equal(result.value.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.deepEqual(result.value.timeouts, {
      models: DEFAULT_TIMEOUT_MS,
      combos: DEFAULT_TIMEOUT_MS,
      autoCombos: DEFAULT_AUTO_COMBOS_TIMEOUT_MS,
      enrichment: DEFAULT_TIMEOUT_MS,
    });
    assert.equal(result.value.cacheTtlMs, DEFAULT_CACHE_TTL_MS);
    assert.equal(result.value.usableOnly, false);
    assert.equal(result.value.enrichment, true);
    assert.equal(result.value.providerTag, true);
    assert.equal(result.value.geminiSanitization, true);
    assert.deepEqual(result.value.visibleModels, []);
    assert.deepEqual(result.value.hiddenModels, []);
    assert.equal(result.value.allowAnthropic, false);
    assert.deepEqual(result.value.anthropicModels, []);
    assert.equal(result.value.anthropicPrefixes, undefined);
    assert.equal(result.value.logLevel, "warn");
    assert.deepEqual([...DEFAULT_ANTHROPIC_PREFIXES], ["cc", "claude", "anthropic", "kiro", "kr"]);
  }
});

test("honours explicit flags, lists, timeouts and log level", async () => {
  const result = await loadOmniRouteConfig(
    {
      OPENCODE_OMNIROUTE_URL: "http://gw:20128",
      OPENCODE_OMNIROUTE_API_KEY: "k",
      OPENCODE_OMNIROUTE_PROVIDER_ID: "custom-gw",
      OPENCODE_OMNIROUTE_DISPLAY_NAME: "Custom",
      OPENCODE_OMNIROUTE_TIMEOUT_MS: "7000",
      OPENCODE_OMNIROUTE_MODELS_TIMEOUT_MS: "1000",
      OPENCODE_OMNIROUTE_COMBOS_TIMEOUT_MS: "2000",
      OPENCODE_OMNIROUTE_AUTO_COMBOS_TIMEOUT_MS: "3000",
      OPENCODE_OMNIROUTE_ENRICHMENT_TIMEOUT_MS: "4000",
      OPENCODE_OMNIROUTE_CACHE_TTL_MS: "60000",
      OPENCODE_OMNIROUTE_USABLE_ONLY: "true",
      OPENCODE_OMNIROUTE_ENRICHMENT: "off",
      OPENCODE_OMNIROUTE_PROVIDER_TAG: "0",
      OPENCODE_OMNIROUTE_GEMINI_SANITIZATION: "no",
      OPENCODE_OMNIROUTE_VISIBLE_MODELS: "cc/a, b",
      OPENCODE_OMNIROUTE_HIDDEN_MODELS: "cc/secret",
      OPENCODE_OMNIROUTE_ALLOW_ANTHROPIC: "1",
      OPENCODE_OMNIROUTE_ANTHROPIC_MODELS: "cc/claude-x",
      OPENCODE_OMNIROUTE_ANTHROPIC_PREFIXES: "cc",
      OPENCODE_OMNIROUTE_LOG_LEVEL: "debug",
    },
    join(tmpdir(), "definitely-missing-omniroute.conf"),
  );
  assert.equal(result.ok, true);
  if (!result.ok || !result.value) assert.fail("expected config");
  else {
    assert.equal(result.value.providerID, "custom-gw");
    assert.equal(result.value.displayName, "Custom");
    assert.equal(result.value.timeoutMs, 7000);
    assert.deepEqual(result.value.timeouts, {
      models: 1000,
      combos: 2000,
      autoCombos: 3000,
      enrichment: 4000,
    });
    assert.equal(result.value.cacheTtlMs, 60000);
    assert.equal(result.value.usableOnly, true);
    assert.equal(result.value.enrichment, false);
    assert.equal(result.value.providerTag, false);
    assert.equal(result.value.geminiSanitization, false);
    assert.deepEqual(result.value.visibleModels, ["cc/a", "b"]);
    assert.deepEqual(result.value.hiddenModels, ["cc/secret"]);
    assert.equal(result.value.allowAnthropic, true);
    assert.deepEqual(result.value.anthropicModels, ["cc/claude-x"]);
    assert.deepEqual(result.value.anthropicPrefixes, ["cc"]);
    assert.equal(result.value.logLevel, "debug");
  }
});

test("falls back to invalid numeric/boolean values instead of failing", async () => {
  const result = await loadOmniRouteConfig(
    {
      OPENCODE_OMNIROUTE_URL: "http://gw:20128",
      OPENCODE_OMNIROUTE_TIMEOUT_MS: "banana",
      OPENCODE_OMNIROUTE_USABLE_ONLY: "maybe",
      OPENCODE_OMNIROUTE_LOG_LEVEL: "verbose",
    },
    join(tmpdir(), "definitely-missing-omniroute.conf"),
  );
  assert.equal(result.ok, true);
  if (!result.ok || !result.value) assert.fail("expected config");
  else {
    assert.equal(result.value.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(result.value.usableOnly, false);
    assert.equal(result.value.logLevel, "warn");
  }
});

test("rejects an invalid provider id", async () => {
  for (const providerID of ["../evil", "has space", "a/b", "x".repeat(65), ".", ".."]) {
    const result = await loadOmniRouteConfig(
      {
        OPENCODE_OMNIROUTE_URL: "http://gw:20128",
        OPENCODE_OMNIROUTE_PROVIDER_ID: providerID,
      },
      join(tmpdir(), "definitely-missing-omniroute.conf"),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /PROVIDER_ID/u);
  }
});

test("validates provider ids", () => {
  assert.equal(isProviderID("omniroute"), true);
  assert.equal(isProviderID("gw-1.x"), true);
  assert.equal(isProviderID(""), false);
  assert.equal(isProviderID("../x"), false);
  assert.equal(isProviderID(42), false);
});

test("reads missing values from the fallback file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omniroute-fallback-"));
  const fallbackPath = join(directory, "omniroute.conf");
  await writeFile(
    fallbackPath,
    "OPENCODE_OMNIROUTE_URL=http://file:20128/v1\nOPENCODE_OMNIROUTE_API_KEY=file-key\nOPENCODE_OMNIROUTE_MANAGEMENT_API_KEY=file-mgmt\n",
  );
  const result = await loadOmniRouteConfig({}, fallbackPath);
  assert.equal(result.ok, true);
  if (!result.ok || !result.value) assert.fail("expected config");
  else {
    assert.equal(result.value.baseURL, "http://file:20128/v1");
    assert.equal(result.value.apiKey, "file-key");
    assert.equal(result.value.managementKey, "file-mgmt");
  }
});

test("parses only supported fallback-file assignments", () => {
  assert.deepEqual(
    parseOmniRouteEnvironmentFile(
      '# c\nOPENCODE_OMNIROUTE_URL="http://x:20128"\nexport OPENCODE_OMNIROUTE_API_KEY=k\nUNRELATED=v\nOMNIROUTE_API_KEY=ignored\n',
    ),
    { OPENCODE_OMNIROUTE_URL: "http://x:20128", OPENCODE_OMNIROUTE_API_KEY: "k" },
  );
});

test("normalizes gateway roots", () => {
  assert.equal(normalizeGatewayRoot("https://Example.COM/api/v1/"), "https://example.com/api");
  assert.throws(() => normalizeGatewayRoot("https://example.com/v1?x=1"), /must not contain/u);
});

test("parses quoted and tiny fallback values", () => {
  assert.deepEqual(parseOmniRouteEnvironmentFile("OPENCODE_OMNIROUTE_API_KEY='quoted'\n"), {
    OPENCODE_OMNIROUTE_API_KEY: "quoted",
  });
  assert.deepEqual(parseOmniRouteEnvironmentFile("OPENCODE_OMNIROUTE_API_KEY=x\n"), {
    OPENCODE_OMNIROUTE_API_KEY: "x",
  });
  assert.deepEqual(parseOmniRouteEnvironmentFile("OPENCODE_OMNIROUTE_API_KEY=\n"), {
    OPENCODE_OMNIROUTE_API_KEY: "",
  });
});

test("reports unreadable fallback files and unexpected failures safely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omniroute-unreadable-"));
  const unreadable = await loadOmniRouteConfig({}, directory);
  assert.equal(unreadable.ok, false);
  if (!unreadable.ok) assert.match(unreadable.error.message, /Unable to read/u);

  const throwing = {
    get OPENCODE_OMNIROUTE_URL(): string | undefined {
      throw new TypeError("boom");
    },
  };
  const wrapped = await loadOmniRouteConfig(
    throwing as unknown as Record<string, string | undefined>,
    join(tmpdir(), "definitely-missing-omniroute.conf"),
  );
  assert.equal(wrapped.ok, false);
  if (!wrapped.ok) assert.equal(wrapped.error.message, "Invalid omniroute configuration");
});

test("leaves anthropic prefixes unset when the variable is blank", async () => {
  const result = await loadOmniRouteConfig(
    {
      OPENCODE_OMNIROUTE_URL: "http://gw:20128",
      OPENCODE_OMNIROUTE_ANTHROPIC_PREFIXES: "  ",
    },
    join(tmpdir(), "definitely-missing-omniroute.conf"),
  );
  assert.equal(result.ok, true);
  if (!result.ok || !result.value) assert.fail("expected config");
  else assert.equal(result.value.anthropicPrefixes, undefined);
});

test("rejects non-positive timeouts and honours empty management keys", async () => {
  const result = await loadOmniRouteConfig(
    {
      OPENCODE_OMNIROUTE_URL: "http://gw:20128",
      OPENCODE_OMNIROUTE_TIMEOUT_MS: "0",
      OPENCODE_OMNIROUTE_CACHE_TTL_MS: "-5",
      OPENCODE_OMNIROUTE_MANAGEMENT_API_KEY: "",
    },
    join(tmpdir(), "definitely-missing-omniroute.conf"),
  );
  assert.equal(result.ok, true);
  if (!result.ok || !result.value) assert.fail("expected config");
  else {
    assert.equal(result.value.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(result.value.cacheTtlMs, DEFAULT_CACHE_TTL_MS);
    assert.equal(result.value.managementKey, undefined);
  }
});

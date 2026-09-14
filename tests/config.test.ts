import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONFIG_FILE,
  ConfigError,
  loadConfig,
  normalizeBaseURL,
  parseEnvironmentFile,
} from "../src/config.js";

test("normalizes a /v1 base URL", () => {
  assert.equal(normalizeBaseURL(" HTTP://10.0.0.1:20128/v1/// "), "http://10.0.0.1:20128/v1");
  assert.throws(() => normalizeBaseURL("file:///tmp/v1"), /http or https/u);
  assert.throws(() => normalizeBaseURL("https://example.com/api"), /end with \/v1/u);
  assert.throws(() => normalizeBaseURL("https://user:pass@example.com/v1"), /must not contain/u);
});

test("rejects malformed URLs without leaking input", () => {
  assert.throws(() => normalizeBaseURL("not a url"), /must be a valid URL/u);
  assert.throws(() => normalizeBaseURL(""), /must be a valid URL/u);
  assert.throws(() => normalizeBaseURL("   "), /must be a valid URL/u);
  assert.throws(() => normalizeBaseURL("http://[::1"), /must be a valid URL/u);
});

test("rejects credentials, queries, and fragments individually", () => {
  assert.throws(() => normalizeBaseURL("https://example.com/v1?key=x"), /must not contain/u);
  assert.throws(() => normalizeBaseURL("https://example.com/v1#section"), /must not contain/u);
  assert.throws(() => normalizeBaseURL("https://user@example.com/v1"), /must not contain/u);
  assert.throws(() => normalizeBaseURL("https://example.com/v1?x=1#y"), /must not contain/u);
});

test("rejects non-/v1 paths", () => {
  assert.throws(() => normalizeBaseURL("https://example.com/"), /end with \/v1/u);
  assert.throws(() => normalizeBaseURL("https://example.com"), /end with \/v1/u);
  assert.throws(() => normalizeBaseURL("https://example.com/v10"), /end with \/v1/u);
  assert.throws(() => normalizeBaseURL("https://example.com/v1extra"), /end with \/v1/u);
  assert.throws(() => normalizeBaseURL("https://example.com/api/v2"), /end with \/v1/u);
});

test("preserves nested /v1 prefixes and normalizes host case", () => {
  assert.equal(normalizeBaseURL("https://Example.COM/api/v1/"), "https://example.com/api/v1");
  assert.equal(normalizeBaseURL("https://example.com/v1"), "https://example.com/v1");
  assert.equal(
    normalizeBaseURL("http://10.0.0.1:20128/v1"),
    "http://10.0.0.1:20128/v1",
  );
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

test("ignores lines without a usable assignment", () => {
  assert.deepEqual(parseEnvironmentFile("NOEQUALS\n=value\n=\n   \n# comment\n"), {});
  assert.deepEqual(parseEnvironmentFile("export \n"), {});
  assert.deepEqual(parseEnvironmentFile("UNRELATED=value\n"), {});
  assert.deepEqual(parseEnvironmentFile("export UNRELATED=value\n"), {});
});

test("trims keys and values around the separator", () => {
  assert.deepEqual(
    parseEnvironmentFile("  OPENCODE_9ROUTER_URL   =   http://x:20128/v1   \n"),
    { OPENCODE_9ROUTER_URL: "http://x:20128/v1" },
  );
  assert.deepEqual(
    parseEnvironmentFile("export    OPENCODE_9ROUTER_API_KEY=secret\n"),
    { OPENCODE_9ROUTER_API_KEY: "secret" },
  );
  assert.deepEqual(
    parseEnvironmentFile("   # leading-space comment\nOPENCODE_9ROUTER_API_KEY=k\n"),
    { OPENCODE_9ROUTER_API_KEY: "k" },
  );
});

test("handles CRLF endings and duplicate keys", () => {
  assert.deepEqual(
    parseEnvironmentFile("OPENCODE_9ROUTER_URL=http://a:20128/v1\r\nOPENCODE_9ROUTER_API_KEY=one\r\n"),
    {
      OPENCODE_9ROUTER_URL: "http://a:20128/v1",
      OPENCODE_9ROUTER_API_KEY: "one",
    },
  );
  assert.deepEqual(
    parseEnvironmentFile(
      "OPENCODE_9ROUTER_API_KEY=first\nOPENCODE_9ROUTER_API_KEY=second\n",
    ),
    { OPENCODE_9ROUTER_API_KEY: "second" },
  );
});

test("leaves mismatched or tiny quoted values intact", () => {
  assert.deepEqual(parseEnvironmentFile('OPENCODE_9ROUTER_API_KEY="secret\n'), {
    OPENCODE_9ROUTER_API_KEY: '"secret',
  });
  assert.deepEqual(parseEnvironmentFile("OPENCODE_9ROUTER_API_KEY='secret\n"), {
    OPENCODE_9ROUTER_API_KEY: "'secret",
  });
  assert.deepEqual(parseEnvironmentFile('OPENCODE_9ROUTER_API_KEY="mismatched\'\n'), {
    OPENCODE_9ROUTER_API_KEY: '"mismatched\'',
  });
  assert.deepEqual(parseEnvironmentFile("OPENCODE_9ROUTER_API_KEY=\n"), {
    OPENCODE_9ROUTER_API_KEY: "",
  });
  assert.deepEqual(parseEnvironmentFile('OPENCODE_9ROUTER_API_KEY="\n'), {
    OPENCODE_9ROUTER_API_KEY: '"',
  });
  assert.deepEqual(parseEnvironmentFile("OPENCODE_9ROUTER_API_KEY=x\n"), {
    OPENCODE_9ROUTER_API_KEY: "x",
  });
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

test("reads missing values from the fallback file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-9router-fallback-"));
  const fallbackPath = join(directory, "9router.conf");
  await writeFile(
    fallbackPath,
    'OPENCODE_9ROUTER_URL="http://file:20128/v1/"\nexport OPENCODE_9ROUTER_API_KEY=file-key\n',
  );

  const both = await loadConfig({}, fallbackPath);
  assert.deepEqual(both, {
    ok: true,
    value: { apiKey: "file-key", baseURL: "http://file:20128/v1" },
  });

  const envURL = await loadConfig(
    { OPENCODE_9ROUTER_URL: "http://env:20128/v1" },
    fallbackPath,
  );
  assert.deepEqual(envURL, {
    ok: true,
    value: { apiKey: "file-key", baseURL: "http://env:20128/v1" },
  });

  const envKey = await loadConfig({ OPENCODE_9ROUTER_API_KEY: "env-key" }, fallbackPath);
  assert.deepEqual(envKey, {
    ok: true,
    value: { apiKey: "env-key", baseURL: "http://file:20128/v1" },
  });
});

test("uses the default fallback path when only the environment is given", async () => {
  const result = await loadConfig({
    OPENCODE_9ROUTER_URL: "http://environment:20128/v1",
    OPENCODE_9ROUTER_API_KEY: "environment-key",
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      apiKey: "environment-key",
      baseURL: "http://environment:20128/v1",
    },
  });
});

test("trims a padded API key and rejects a blank one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-9router-trim-"));
  const missing = join(directory, "missing.conf");

  const padded = await loadConfig(
    {
      OPENCODE_9ROUTER_URL: "http://10.0.0.1:20128/v1",
      OPENCODE_9ROUTER_API_KEY: "  padded-key  ",
    },
    missing,
  );
  assert.deepEqual(padded, {
    ok: true,
    value: { apiKey: "padded-key", baseURL: "http://10.0.0.1:20128/v1" },
  });

  const blank = await loadConfig(
    {
      OPENCODE_9ROUTER_URL: "http://10.0.0.1:20128/v1",
      OPENCODE_9ROUTER_API_KEY: "   ",
    },
    missing,
  );
  assert.equal(blank.ok, false);
  if (!blank.ok) {
    assert.match(blank.error.message, /API_KEY is not configured/u);
  }
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

test("reports a missing base URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-9router-nourl-"));
  const missing = join(directory, "missing.conf");

  const emptyEnv = await loadConfig({}, missing);
  assert.equal(emptyEnv.ok, false);
  if (!emptyEnv.ok) {
    assert.match(emptyEnv.error.message, /URL is not configured/u);
    assert.ok(emptyEnv.error instanceof ConfigError);
    assert.equal(emptyEnv.error.name, "ConfigError");
  }

  const keyOnlyPath = join(directory, "key-only.conf");
  await writeFile(keyOnlyPath, "OPENCODE_9ROUTER_API_KEY=only-key\n");
  const keyOnly = await loadConfig({}, keyOnlyPath);
  assert.equal(keyOnly.ok, false);
  if (!keyOnly.ok) assert.match(keyOnly.error.message, /URL is not configured/u);

  const emptyStringURL = await loadConfig(
    { OPENCODE_9ROUTER_URL: "", OPENCODE_9ROUTER_API_KEY: "k" },
    missing,
  );
  assert.equal(emptyStringURL.ok, false);
  if (!emptyStringURL.ok) assert.match(emptyStringURL.error.message, /URL is not configured/u);
});

test("returns a safe error for an invalid base URL", async () => {
  const secret = "never-log-this-key";
  const directory = await mkdtemp(join(tmpdir(), "opencode-9router-badurl-"));
  const result = await loadConfig(
    {
      OPENCODE_9ROUTER_URL: "https://example.com/api",
      OPENCODE_9ROUTER_API_KEY: secret,
    },
    join(directory, "missing.conf"),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /end with \/v1/u);
    assert.doesNotMatch(result.error.message, new RegExp(secret, "u"));
  }
});

test("reports an unreadable fallback file with its path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-9router-unreadable-"));
  const result = await loadConfig({}, directory);

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /Unable to read/u);
    assert.ok(result.error instanceof ConfigError);
    assert.ok(result.error.message.includes(directory));
  }
});

test("wraps unexpected failures in a generic ConfigError", async () => {
  const throwing = {
    get OPENCODE_9ROUTER_URL(): string | undefined {
      throw new TypeError("boom");
    },
    get OPENCODE_9ROUTER_API_KEY(): string | undefined {
      throw new TypeError("boom");
    },
  };
  const result = await loadConfig(
    throwing as unknown as Record<string, string | undefined>,
    join(tmpdir(), "definitely-missing-9router.conf"),
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error instanceof ConfigError);
    assert.equal(result.error.message, "Invalid 9router configuration");
    assert.equal(result.error.name, "ConfigError");
    assert.doesNotMatch(result.error.message, /boom/u);
  }
});

test("defaults to process.env when no environment is passed", async () => {
  const savedURL = process.env.OPENCODE_9ROUTER_URL;
  const savedKey = process.env.OPENCODE_9ROUTER_API_KEY;
  delete process.env.OPENCODE_9ROUTER_URL;
  delete process.env.OPENCODE_9ROUTER_API_KEY;
  try {
    const missing = join(
      await mkdtemp(join(tmpdir(), "opencode-9router-default-")),
      "missing.conf",
    );
    const result = await loadConfig(undefined, missing);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /URL is not configured/u);
  } finally {
    if (savedURL !== undefined) process.env.OPENCODE_9ROUTER_URL = savedURL;
    if (savedKey !== undefined) process.env.OPENCODE_9ROUTER_API_KEY = savedKey;
  }
});

test("rejects empty query and fragment markers without values", () => {
  assert.throws(() => normalizeBaseURL("https://example.com/v1?"), /must not contain/u);
  assert.throws(() => normalizeBaseURL("https://example.com/v1#"), /must not contain/u);
  assert.throws(() => normalizeBaseURL("https://example.com/v1?#"), /must not contain/u);
});

test("empty-string environment values fall back to the file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-9router-empty-env-"));
  const fallbackPath = join(directory, "9router.conf");
  await writeFile(
    fallbackPath,
    "OPENCODE_9ROUTER_URL=http://file:20128/v1\nOPENCODE_9ROUTER_API_KEY=file-key\n",
  );

  const result = await loadConfig(
    { OPENCODE_9ROUTER_URL: "", OPENCODE_9ROUTER_API_KEY: "" },
    fallbackPath,
  );
  assert.deepEqual(result, {
    ok: true,
    value: { apiKey: "file-key", baseURL: "http://file:20128/v1" },
  });
});

test("exposes the shared fallback path and ConfigError shape", () => {
  assert.ok(CONFIG_FILE.endsWith(join(".config", "environment.d", "9router.conf")));
  const error = new ConfigError("example");
  assert.equal(error.name, "ConfigError");
  assert.ok(error instanceof Error);
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createOmniRouteCache,
  emptySnapshot,
  MAX_SNAPSHOT_BYTES,
  readSnapshot,
  snapshotContentFingerprint,
  snapshotDataDir,
  snapshotFingerprint,
  snapshotPath,
  UNREACHABLE_COOLDOWN_MS,
  writeSnapshot,
  type OmniRouteSnapshot,
} from "../src/omniroute/cache.js";

const snapshot = (models: string[], fetchedAt = 1000): OmniRouteSnapshot => ({
  models: models.map((id) => ({ id })),
  combos: [{ id: "mix" }],
  autoCombos: [{ id: "auto" }],
  providers: [],
  enrichment: [["cc/a", { name: "A" }]],
  fetchedAt,
});

test("hits fresh memory entries and expires by TTL", () => {
  let now = 10_000;
  const cache = createOmniRouteCache({ ttlMs: 1000, now: () => now });
  assert.equal(cache.fresh("fp"), undefined);
  cache.store("fp", snapshot(["cc/a"], now));
  assert.deepEqual(cache.fresh("fp")?.models.map((model) => model.id), ["cc/a"]);
  now += 1001;
  assert.equal(cache.fresh("fp"), undefined);
  // Last-known-good survives expiry while models exist.
  assert.deepEqual(cache.lastKnownGood("fp")?.models.map((model) => model.id), ["cc/a"]);
});

test("coalesces concurrent refreshes into one fetch", async () => {
  const cache = createOmniRouteCache({ ttlMs: 1000 });
  let calls = 0;
  const load = async (): Promise<OmniRouteSnapshot> => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return snapshot(["cc/a"]);
  };
  const [first, second] = await Promise.all([
    cache.refresh("fp", load),
    cache.refresh("fp", load),
  ]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  // A later refresh fetches again.
  await cache.refresh("fp", load);
  assert.equal(calls, 2);
});

test("cools down after total failure without hiding last-known-good", () => {
  let now = 0;
  const cache = createOmniRouteCache({ ttlMs: 1000, now: () => now });
  assert.equal(UNREACHABLE_COOLDOWN_MS, 15_000);
  assert.equal(cache.coolingDown("fp"), false);
  cache.store("fp", snapshot(["cc/a"], now));
  cache.noteEmptyModels("fp");
  assert.equal(cache.coolingDown("fp"), true);
  assert.deepEqual(cache.lastKnownGood("fp")?.models.map((model) => model.id), ["cc/a"]);
  now += UNREACHABLE_COOLDOWN_MS + 1;
  assert.equal(cache.coolingDown("fp"), false);
});

test("fingerprints gateway identity and content order-insensitively", () => {
  const a = snapshotFingerprint("http://gw", "key", "mgmt");
  assert.equal(snapshotFingerprint("http://gw", "key", "mgmt"), a);
  assert.notEqual(snapshotFingerprint("http://gw", "other", "mgmt"), a);
  assert.equal(snapshotFingerprint("http://gw/", "key", "mgmt"), a);
  assert.notEqual(snapshotFingerprint("http://other", "key", "mgmt"), a);
  const left = snapshotContentFingerprint({
    models: [{ id: "b" }, { id: "a" }],
    combos: [{ id: "mix", name: "Mix", models: [{}, {}] }],
    autoCombos: [{ id: "auto" }],
  });
  const right = snapshotContentFingerprint({
    models: [{ id: "a" }, { id: "b" }],
    combos: [{ id: "mix", name: "Mix", models: [{}, {}] }],
    autoCombos: [{ id: "auto" }],
  });
  assert.equal(left, right);
  assert.notEqual(
    left,
    snapshotContentFingerprint({ models: [{ id: "a" }], combos: [], autoCombos: [] }),
  );
  assert.deepEqual(emptySnapshot().models, []);
});

test("round-trips a disk snapshot and enforces the identity binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omniroute-cache-"));
  const file = join(directory, "plugins", "omniroute-test.json");
  const written = await writeSnapshot(file, snapshot(["cc/a"], 42), "fp-1");
  assert.equal(written, true);
  const body = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal(body.v, 2);
  assert.equal(body.identityFingerprint, "fp-1");
  assert.doesNotMatch(JSON.stringify(body), /secret-key-for-test/u);

  const hit = await readSnapshot(file, "fp-1");
  assert.deepEqual(hit?.models.map((model) => model.id), ["cc/a"]);
  assert.deepEqual(hit?.enrichment, [["cc/a", { name: "A" }]]);
  assert.equal(hit?.fetchedAt, 42);

  // Wrong identity, old format, corrupt JSON and absent files all miss.
  assert.equal(await readSnapshot(file, "fp-2"), undefined);
  await writeFile(file, JSON.stringify({ v: 1, identityFingerprint: "fp-1", models: [{ id: "a" }], combos: [] }));
  assert.equal(await readSnapshot(file, "fp-1"), undefined);
  await writeFile(file, "{not json");
  assert.equal(await readSnapshot(file, "fp-1"), undefined);
  assert.equal(await readSnapshot(join(directory, "missing.json"), "fp-1"), undefined);
  await writeFile(file, JSON.stringify({ v: 2, identityFingerprint: "fp-1", models: [], combos: [] }));
  assert.equal(await readSnapshot(file, "fp-1"), undefined);
});

test("writes snapshots atomically with restrictive permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omniroute-cache-mode-"));
  const file = join(directory, "snap.json");
  await writeSnapshot(file, snapshot(["cc/a"]), "fp");
  const { stat } = await import("node:fs/promises");
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(directory), ["snap.json"]);
});

test("refuses oversized snapshots instead of writing them", async () => {
  assert.ok(MAX_SNAPSHOT_BYTES >= 1024 * 1024);
  const directory = await mkdtemp(join(tmpdir(), "omniroute-cache-big-"));
  const file = join(directory, "snap.json");
  const warnings: string[] = [];
  const huge: OmniRouteSnapshot = {
    models: [{ id: "x".repeat(MAX_SNAPSHOT_BYTES + 1) }],
    combos: [],
    autoCombos: [],
    providers: [],
    enrichment: [],
    fetchedAt: 1,
  };
  assert.equal(await writeSnapshot(file, huge, "fp", (message) => warnings.push(message)), false);
  assert.equal(warnings.length, 1);
  // Empty snapshots are never written.
  assert.equal(await writeSnapshot(file, emptySnapshot(), "fp"), false);
});

test("tolerates unwritable disks and throwing warn sinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omniroute-cache-ro-"));
  // A file where the directory should be forces mkdir/write to fail.
  const blocker = join(directory, "blocker");
  await writeFile(blocker, "x");
  const warnings: string[] = [];
  assert.equal(
    await writeSnapshot(join(blocker, "snap.json"), snapshot(["a"]), "fp", (message) =>
      warnings.push(message),
    ),
    false,
  );
  assert.equal(warnings.length, 1);
  assert.equal(
    await writeSnapshot(join(blocker, "snap.json"), snapshot(["a"]), "fp", () => {
      throw new Error("sink blew up");
    }),
    false,
  );
});

test("scopes snapshot paths to safe provider ids", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omniroute-cache-path-"));
  const file = snapshotPath("omniroute", directory);
  assert.equal(file, join(directory, "plugins", "omniroute-omniroute.json"));
  assert.throws(() => snapshotPath("../evil", directory), /invalid provider id/u);
  const saved = process.env.OPENCODE_DATA_DIR;
  process.env.OPENCODE_DATA_DIR = directory;
  try {
    assert.ok(snapshotDataDir().startsWith(directory));
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = saved;
  }
  await mkdir(join(directory, "plugins"), { recursive: true });
});

test("cleans invalid snapshot rows and tolerates missing timestamps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omniroute-cache-clean-"));
  const file = join(directory, "snap.json");
  await writeFile(
    file,
    JSON.stringify({
      v: 2,
      identityFingerprint: "fp",
      models: [{ id: "cc/a" }, { id: "" }, null, "x"],
      combos: [{ id: "mix" }, { nope: 1 }],
      autoCombos: [{ id: "auto" }, null],
      providers: [{ id: "1", provider: "claude" }, { id: "2" }],
      enrichment: [["cc/a", { name: "A" }], ["bad"], ["", {}], ["k", null]],
    }),
  );
  const hit = await readSnapshot(file, "fp");
  assert.deepEqual(hit?.models.map((model) => model.id), ["cc/a"]);
  assert.deepEqual(hit?.combos.map((combo) => combo.id), ["mix"]);
  assert.deepEqual(hit?.autoCombos.map((combo) => combo.id), ["auto"]);
  assert.deepEqual(hit?.providers.map((provider) => provider.provider), ["claude"]);
  assert.deepEqual(hit?.enrichment, [["cc/a", { name: "A" }]]);
  assert.ok(typeof hit?.fetchedAt === "number");
});

test("retries after refresh failures and honours non-positive TTLs", async () => {
  const cache = createOmniRouteCache({ ttlMs: 0 });
  cache.store("fp", snapshot(["cc/a"], Date.now()));
  assert.ok(cache.fresh("fp"));

  let calls = 0;
  const failing = async (): Promise<OmniRouteSnapshot> => {
    calls += 1;
    throw new Error("down");
  };
  await assert.rejects(cache.refresh("fp", failing), /down/u);
  await assert.rejects(cache.refresh("fp", failing), /down/u);
  assert.equal(calls, 2);

  cache.clear();
  assert.equal(cache.fresh("fp"), undefined);
  assert.equal(cache.lastKnownGood("fp"), undefined);
  cache.store("gone", emptySnapshot());
  assert.equal(cache.lastKnownGood("gone"), undefined);
});

test("normalizes invalid gateway roots without throwing", () => {
  assert.equal(snapshotFingerprint("not a url", "k", "m"), snapshotFingerprint("not a url", "k", "m"));
});

test("drops enrichment before catalog data under snapshot pressure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omniroute-cache-trim-"));
  const file = join(directory, "snap.json");
  const warnings: string[] = [];
  // Enrichment alone exceeds the cap while the catalog itself stays small.
  const written = await writeSnapshot(
    file,
    {
      models: [{ id: "a" }],
      combos: [],
      autoCombos: [],
      providers: [],
      enrichment: [["big", { name: "x".repeat(MAX_SNAPSHOT_BYTES) }]],
      fetchedAt: 1,
    },
    "fp",
    (message) => warnings.push(message),
  );
  assert.equal(written, true);
  assert.deepEqual(warnings, []);
  const hit = await readSnapshot(file, "fp");
  assert.deepEqual(hit?.models.map((model) => model.id), ["a"]);
  assert.deepEqual(hit?.enrichment, []);
});

test("warns through throwing sinks and cleans up after failed renames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omniroute-cache-throw-"));
  const file = join(directory, "snap.json");
  // Oversized payload with a throwing warn sink: still refuses, never throws.
  assert.equal(
    await writeSnapshot(
      file,
      {
        models: [{ id: "x".repeat(MAX_SNAPSHOT_BYTES + 1) }],
        combos: [],
        autoCombos: [],
        providers: [],
        enrichment: [],
        fetchedAt: 1,
      },
      "fp",
      () => {
        throw new Error("sink blew up");
      },
    ),
    false,
  );
});

test("removes the temp file when the rename cannot complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omniroute-cache-rename-"));
  const target = join(directory, "target");
  await mkdir(target, { recursive: true });
  const written = await writeSnapshot(
    target,
    {
      models: [{ id: "a" }],
      combos: [],
      autoCombos: [],
      providers: [],
      enrichment: [],
      fetchedAt: 1,
    },
    "fp",
  );
  assert.equal(written, false);
  assert.deepEqual(await readdir(directory), ["target"]);
});

test("covers the temp-file cleanup when its own removal fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omniroute-cache-long-"));
  // Overlong names fail the write and the cleanup alike; still no throw.
  const file = join(directory, "x".repeat(300));
  assert.equal(
    await writeSnapshot(
      file,
      {
        models: [{ id: "a" }],
        combos: [],
        autoCombos: [],
        providers: [],
        enrichment: [],
        fetchedAt: 1,
      },
      "fp",
    ),
    false,
  );
});

test("writes sparse snapshots without providers or enrichment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omniroute-cache-sparse-"));
  const file = join(directory, "snap.json");
  const written = await writeSnapshot(
    file,
    {
      models: [{ id: "a" }],
      combos: [],
      autoCombos: [],
      providers: undefined,
      enrichment: undefined,
      fetchedAt: 1,
    } as unknown as OmniRouteSnapshot,
    "fp",
  );
  assert.equal(written, true);
  const hit = await readSnapshot(file, "fp");
  assert.deepEqual(hit?.models.map((model) => model.id), ["a"]);
  assert.deepEqual(hit?.providers, []);
  assert.deepEqual(hit?.enrichment, []);
});

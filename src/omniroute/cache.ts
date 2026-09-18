import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isProviderID } from "./config.js";
import type {
  OmniRouteEnrichmentEntry,
  OmniRouteProviderConnection,
  OmniRouteRawAutoCombo,
  OmniRouteRawCombo,
  OmniRouteRawModelEntry,
} from "./catalog.js";

export const SNAPSHOT_FORMAT_VERSION = 2;
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const UNREACHABLE_COOLDOWN_MS = 15_000;

export type SnapshotEnrichment = Array<readonly [string, OmniRouteEnrichmentEntry]>;

export type OmniRouteSnapshot = {
  readonly models: OmniRouteRawModelEntry[];
  readonly combos: OmniRouteRawCombo[];
  readonly autoCombos: OmniRouteRawAutoCombo[];
  readonly providers: OmniRouteProviderConnection[];
  readonly enrichment: SnapshotEnrichment;
  readonly fetchedAt: number;
};

export const emptySnapshot = (fetchedAt = 0): OmniRouteSnapshot => ({
  models: [],
  combos: [],
  autoCombos: [],
  providers: [],
  enrichment: [],
  fetchedAt,
});

const normalizeRoot = (gatewayRoot: string): string => {
  try {
    const parsed = new URL(gatewayRoot);
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    parsed.pathname = pathname;
    return parsed.toString();
  } catch {
    return gatewayRoot.replace(/\/+$/u, "");
  }
};

/** One-way fingerprint of gateway + credential identity. No secrets stored. */
export const snapshotFingerprint = (
  gatewayRoot: string,
  apiKey: string,
  managementKey: string,
): string =>
  createHash("sha256")
    .update(JSON.stringify([normalizeRoot(gatewayRoot), apiKey, managementKey]))
    .digest("hex");

/** Order-insensitive content digest for reload-on-change decisions. */
export const snapshotContentFingerprint = (snapshot: {
  readonly models: ReadonlyArray<{ readonly id: string }>;
  readonly combos: ReadonlyArray<{ readonly id: string; readonly name?: unknown; readonly models?: unknown }>;
  readonly autoCombos: ReadonlyArray<{ readonly id: string }>;
}): string => {
  const models = snapshot.models
    .map((model) => model.id)
    .sort()
    .join("\n");
  const combos = snapshot.combos
    .map((combo) => {
      const count = Array.isArray(combo.models) ? combo.models.length : 0;
      const name = typeof combo.name === "string" ? combo.name : "";
      return `${combo.id}|${name}|${count}`;
    })
    .sort()
    .join("\n");
  const autoCombos = snapshot.autoCombos
    .map((combo) => combo.id)
    .sort()
    .join("\n");
  return createHash("sha256").update(`${models}\n${combos}\n${autoCombos}`).digest("hex");
};

export type OmniRouteCacheOptions = {
  readonly ttlMs: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
};

export type OmniRouteCache = {
  /** Fresh entry, or undefined when absent/stale. */
  readonly fresh: (fingerprint: string) => OmniRouteSnapshot | undefined;
  /** Last-known-good entry regardless of age. */
  readonly lastKnownGood: (fingerprint: string) => OmniRouteSnapshot | undefined;
  readonly store: (fingerprint: string, snapshot: OmniRouteSnapshot) => void;
  /** Coalesces concurrent refreshes for one identity into a single fetch. */
  readonly refresh: <T>(fingerprint: string, load: () => Promise<T>) => Promise<T>;
  /** True while a total models failure should suppress refetching. */
  readonly coolingDown: (fingerprint: string) => boolean;
  readonly noteEmptyModels: (fingerprint: string) => void;
  readonly clear: () => void;
};

export const createOmniRouteCache = (options: OmniRouteCacheOptions): OmniRouteCache => {
  const ttlMs = options.ttlMs > 0 ? options.ttlMs : 300_000;
  const cooldownMs = options.cooldownMs ?? UNREACHABLE_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, OmniRouteSnapshot>();
  const inFlight = new Map<string, Promise<unknown>>();
  const cooledUntil = new Map<string, number>();

  return {
    fresh: (fingerprint) => {
      const entry = entries.get(fingerprint);
      if (!entry || entry.fetchedAt + ttlMs <= now()) return undefined;
      return entry;
    },
    lastKnownGood: (fingerprint) => {
      const entry = entries.get(fingerprint);
      return entry && entry.models.length > 0 ? entry : undefined;
    },
    store: (fingerprint, snapshot) => {
      entries.set(fingerprint, snapshot);
    },
    refresh: <T>(fingerprint: string, load: () => Promise<T>): Promise<T> => {
      const running = inFlight.get(fingerprint);
      if (running) return running as Promise<T>;
      const task: Promise<T> = load().finally(() => {
        if (inFlight.get(fingerprint) === task) inFlight.delete(fingerprint);
      });
      inFlight.set(fingerprint, task);
      return task;
    },
    coolingDown: (fingerprint) => (cooledUntil.get(fingerprint) ?? 0) > now(),
    noteEmptyModels: (fingerprint) => {
      cooledUntil.set(fingerprint, now() + cooldownMs);
    },
    clear: () => {
      entries.clear();
      inFlight.clear();
      cooledUntil.clear();
    },
  };
};

export const snapshotDataDir = (): string =>
  process.env.OPENCODE_DATA_DIR ?? join(homedir(), ".local", "share", "opencode");

export const snapshotPath = (providerID: string, dataDir = snapshotDataDir()): string => {
  if (!isProviderID(providerID)) {
    throw new Error("Refusing to resolve a snapshot path for an invalid provider id");
  }
  return join(dataDir, "plugins", `omniroute-${providerID}.json`);
};

type DiskSnapshot = {
  readonly v: number;
  readonly identityFingerprint: string;
  readonly models: unknown;
  readonly combos: unknown;
  readonly autoCombos?: unknown;
  readonly providers?: unknown;
  readonly enrichment?: unknown;
  readonly fetchedAt?: unknown;
  readonly writtenAt?: unknown;
};

const validID = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const cleanModels = (value: unknown): OmniRouteRawModelEntry[] => {
  if (!Array.isArray(value)) return [];
  const out: OmniRouteRawModelEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { id?: unknown };
    if (!validID(entry.id)) continue;
    out.push(item as OmniRouteRawModelEntry);
  }
  return out;
};

const cleanCombos = (value: unknown): OmniRouteRawCombo[] => {
  if (!Array.isArray(value)) return [];
  const out: OmniRouteRawCombo[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { id?: unknown };
    if (!validID(entry.id)) continue;
    out.push(item as OmniRouteRawCombo);
  }
  return out;
};

const cleanAutoCombos = (value: unknown): OmniRouteRawAutoCombo[] => {
  if (!Array.isArray(value)) return [];
  const out: OmniRouteRawAutoCombo[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { id?: unknown };
    if (!validID(entry.id)) continue;
    out.push(item as OmniRouteRawAutoCombo);
  }
  return out;
};

const cleanProviders = (value: unknown): OmniRouteProviderConnection[] => {
  if (!Array.isArray(value)) return [];
  const out: OmniRouteProviderConnection[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { id?: unknown; provider?: unknown };
    if (typeof entry.provider !== "string" || entry.provider.length === 0) continue;
    out.push(item as OmniRouteProviderConnection);
  }
  return out;
};

const cleanEnrichment = (value: unknown): SnapshotEnrichment => {
  if (!Array.isArray(value)) return [];
  const out: SnapshotEnrichment = [];
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [key, entry] = pair as [unknown, unknown];
    if (typeof key !== "string" || key.length === 0) continue;
    if (!entry || typeof entry !== "object") continue;
    out.push([key, entry as OmniRouteEnrichmentEntry]);
  }
  return out;
};

export const readSnapshot = async (
  file: string,
  identityFingerprint: string,
): Promise<OmniRouteSnapshot | undefined> => {
  try {
    const body = await readFile(file, "utf8");
    const parsed = JSON.parse(body) as Partial<DiskSnapshot>;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (parsed.v !== SNAPSHOT_FORMAT_VERSION) return undefined;
    if (parsed.identityFingerprint !== identityFingerprint) return undefined;
    const models = cleanModels(parsed.models);
    if (models.length === 0) return undefined;
    const fetchedAt =
      typeof parsed.fetchedAt === "number" && Number.isFinite(parsed.fetchedAt)
        ? parsed.fetchedAt
        : typeof parsed.writtenAt === "number"
          ? parsed.writtenAt
          : Date.now();
    return {
      models,
      combos: cleanCombos(parsed.combos),
      autoCombos: cleanAutoCombos(parsed.autoCombos),
      providers: cleanProviders(parsed.providers),
      enrichment: cleanEnrichment(parsed.enrichment),
      fetchedAt,
    };
  } catch {
    return undefined;
  }
};

let writeCounter = 0;

export const writeSnapshot = async (
  file: string,
  snapshot: OmniRouteSnapshot,
  identityFingerprint: string,
  warn?: (message: string) => void,
): Promise<boolean> => {
  if (snapshot.models.length === 0) return false;
  let tmp = "";
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const envelope = {
      v: SNAPSHOT_FORMAT_VERSION,
      identityFingerprint,
      models: snapshot.models,
      combos: snapshot.combos,
      autoCombos: snapshot.autoCombos,
      providers: snapshot.providers,
      enrichment: snapshot.enrichment,
      fetchedAt: snapshot.fetchedAt,
      writtenAt: Date.now(),
    };
    let payload = JSON.stringify(envelope);
    if (Buffer.byteLength(payload, "utf8") > MAX_SNAPSHOT_BYTES) {
      const slim = { ...envelope, enrichment: [] as SnapshotEnrichment };
      payload = JSON.stringify(slim);
    }
    if (Buffer.byteLength(payload, "utf8") > MAX_SNAPSHOT_BYTES) {
      try {
        warn?.(`opencode-9router-v2: omniroute snapshot exceeds the size cap; skipping disk write`);
      } catch {
        // Observability must never break the write path.
      }
      return false;
    }
    tmp = `${file}.${process.pid}.${writeCounter++}.tmp`;
    await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
    return true;
  } catch (error) {
    try {
      warn?.("opencode-9router-v2: omniroute snapshot write failed; keeping the in-memory entry");
    } catch {
      // Observability must never break the write path.
    }
    void error;
    if (tmp) {
      try {
        await unlink(tmp);
      } catch {
        // The temp file may not exist when mkdir failed first.
      }
    }
    return false;
  }
};

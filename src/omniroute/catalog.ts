import type { Model } from "@opencode/plugin";
import { isModelID } from "../discovery.js";
import { DEFAULT_CONTEXT_LIMIT, DEFAULT_OUTPUT_LIMIT } from "../provider.js";
import { DEFAULT_ANTHROPIC_PREFIXES } from "./config.js";

export const OMNIROUTE_OPENAI_PACKAGE = "@opencode/ai/providers/openai-compatible";
export const OMNIROUTE_ANTHROPIC_PACKAGE = "@opencode/ai/providers/anthropic-compatible";

export const MAX_COMBO_PASSES = 8;
export const AUTO_COMBO_FALLBACK_CONTEXT = 128_000;
export const AUTO_COMBO_FALLBACK_OUTPUT = 8_192;

const KNOWN_MODALITIES = new Set(["text", "image", "audio", "video", "pdf"]);

const FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export type OmniRouteRawModelEntry = {
  readonly id: string;
  readonly owned_by?: unknown;
  readonly context_length?: unknown;
  readonly max_input_tokens?: unknown;
  readonly max_output_tokens?: unknown;
  readonly input_modalities?: unknown;
  readonly output_modalities?: unknown;
  readonly capabilities?: {
    readonly tool_calling?: unknown;
    readonly reasoning?: unknown;
    readonly thinking?: unknown;
    readonly attachment?: unknown;
    readonly vision?: unknown;
    readonly temperature?: unknown;
    readonly effort_tiers?: unknown;
  } | null;
  readonly release_date?: unknown;
};

export type OmniRouteRawComboMemberRef = {
  readonly kind?: unknown;
  readonly model?: unknown;
  readonly comboName?: unknown;
};

export type OmniRouteRawCombo = {
  readonly id: string;
  readonly name?: unknown;
  readonly models?: unknown;
  readonly isHidden?: unknown;
  readonly release_date?: unknown;
  readonly computed_context_length?: unknown;
};

export type OmniRouteRawAutoCombo = {
  readonly id: string;
  readonly name?: unknown;
  readonly variant?: unknown;
  readonly candidatePool?: unknown;
  readonly candidateCount?: unknown;
  readonly context_length?: unknown;
  readonly max_output_tokens?: unknown;
  readonly isHidden?: unknown;
};

export type OmniRouteFreeType =
  | "recurring-daily"
  | "recurring-monthly"
  | "recurring-credit"
  | "one-time-initial"
  | "keyless"
  | "discontinued";

export type OmniRouteEnrichmentEntry = {
  name?: string;
  pricing?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  providerAlias?: string;
  providerCanonical?: string;
  providerDisplayName?: string;
  freeType?: OmniRouteFreeType;
  monthlyTokens?: number;
  creditTokens?: number;
};

export type OmniRouteEnrichmentMap = Map<string, OmniRouteEnrichmentEntry>;

export type OmniRouteProviderConnection = {
  readonly id: string;
  readonly provider: string;
  readonly isActive?: unknown;
  readonly testStatus?: unknown;
} & Record<string, unknown>;

export type ApiFormat = {
  readonly allowAnthropic: boolean;
  readonly anthropicModels: readonly string[];
  readonly anthropicPrefixes: readonly string[] | undefined;
};

export type ModelListFilter = {
  readonly exact: ReadonlySet<string>;
  readonly suffixes: ReadonlySet<string>;
};

export type UsableProviderSet = {
  readonly aliases: ReadonlySet<string>;
  readonly canonicals: ReadonlySet<string>;
  readonly knownAliases: ReadonlySet<string>;
};

export const compileListFilter = (list: readonly string[] | undefined): ModelListFilter | undefined => {
  if (!list || list.length === 0) return undefined;
  const exact = new Set<string>();
  const suffixes = new Set<string>();
  for (const id of list) {
    if (id.includes("/")) exact.add(id);
    else suffixes.add(id);
  }
  return { exact, suffixes };
};

const matchesSuffix = (id: string, suffixes: ReadonlySet<string>): boolean => {
  if (suffixes.size === 0) return false;
  const slash = id.indexOf("/");
  const suffix = slash > 0 ? id.slice(slash + 1) : id;
  return suffixes.has(suffix);
};

const matchesFilter = (id: string, filter: ModelListFilter): boolean =>
  filter.exact.has(id) || matchesSuffix(id, filter.suffixes);

/** Hidden rules win over visible rules. */
export const passesVisibility = (
  id: string,
  visible: ModelListFilter | undefined,
  hidden: ModelListFilter | undefined,
): boolean => {
  if (hidden && matchesFilter(id, hidden)) return false;
  if (visible && !matchesFilter(id, visible)) return false;
  return true;
};

const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const modalityList = (value: unknown, fallback: readonly string[]): string[] => {
  if (!Array.isArray(value)) return [...fallback];
  const out = value.filter(
    (entry): entry is string => typeof entry === "string" && KNOWN_MODALITIES.has(entry),
  );
  return out.length > 0 ? out : [...fallback];
};

const releasedAt = (value: unknown): number => {
  if (typeof value !== "string" || value.length === 0) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isComboRef = (step: OmniRouteRawComboMemberRef): boolean => step.kind === "combo-ref";

const stepModelID = (step: OmniRouteRawComboMemberRef): string | undefined =>
  typeof step.model === "string" && step.model.length > 0 ? step.model : undefined;

const comboSteps = (combo: OmniRouteRawCombo): OmniRouteRawComboMemberRef[] =>
  Array.isArray(combo.models)
    ? (combo.models as unknown[]).filter(
        (step): step is OmniRouteRawComboMemberRef =>
          !!step && typeof step === "object",
      )
    : [];

/** A combo passes the visible allowlist when its own id matches, a resolvable member matches, or it has no resolvable members. */
export const passesComboVisibility = (
  combo: OmniRouteRawCombo,
  comboID: string,
  visible: ModelListFilter | undefined,
  hidden: ModelListFilter | undefined,
): boolean => {
  if (hidden && (matchesFilter(comboID, hidden) || comboMembersMatch(combo, hidden))) return false;
  if (!visible) return true;
  if (matchesFilter(comboID, visible)) return true;
  const steps = comboSteps(combo);
  let sawMember = false;
  for (const step of steps) {
    if (isComboRef(step)) continue;
    const modelID = stepModelID(step);
    if (!modelID) continue;
    sawMember = true;
    if (matchesFilter(modelID, visible)) return true;
  }
  return !sawMember;
};

const comboMembersMatch = (combo: OmniRouteRawCombo, filter: ModelListFilter): boolean => {
  for (const step of comboSteps(combo)) {
    if (isComboRef(step)) continue;
    const modelID = stepModelID(step);
    if (modelID && matchesFilter(modelID, filter)) return true;
  }
  return false;
};

export const usableProviderSet = (
  connections: readonly OmniRouteProviderConnection[],
  enrichment: OmniRouteEnrichmentMap | undefined,
): UsableProviderSet | undefined => {
  if (connections.length === 0) return undefined;
  const canonicals = new Set<string>();
  for (const connection of connections) {
    // Absent toggles/verdicts mean "no opinion", never "disabled".
    if (!connection || connection.isActive === false) continue;
    if (typeof connection.testStatus === "string" && connection.testStatus !== "active") continue;
    if (typeof connection.provider === "string" && connection.provider.length > 0) {
      canonicals.add(connection.provider);
    }
  }
  if (canonicals.size === 0) return undefined;
  const aliases = new Set<string>(canonicals);
  const knownAliases = new Set<string>();
  if (enrichment) {
    for (const entry of enrichment.values()) {
      if (typeof entry.providerAlias !== "string" || entry.providerAlias.length === 0) continue;
      knownAliases.add(entry.providerAlias);
      if (
        typeof entry.providerCanonical === "string" &&
        entry.providerCanonical.length > 0 &&
        canonicals.has(entry.providerCanonical)
      ) {
        aliases.add(entry.providerAlias);
      }
    }
  }
  return { aliases, canonicals, knownAliases };
};

/** Subtractive/fail-open: unknown prefixes are always kept. */
export const isUsableModelID = (id: string, usable: UsableProviderSet | undefined): boolean => {
  if (!usable) return true;
  const slash = id.indexOf("/");
  if (slash <= 0) return true;
  const prefix = id.slice(0, slash);
  if (usable.aliases.has(prefix) || usable.canonicals.has(prefix)) return true;
  return !usable.knownAliases.has(prefix);
};

export const isUsableCombo = (
  combo: OmniRouteRawCombo,
  usable: UsableProviderSet | undefined,
): boolean => {
  if (!usable) return true;
  const steps = comboSteps(combo);
  if (steps.length === 0) return true;
  let sawMember = false;
  for (const step of steps) {
    if (isComboRef(step)) continue;
    const modelID = stepModelID(step);
    if (!modelID || modelID.indexOf("/") <= 0) continue;
    sawMember = true;
    if (isUsableModelID(modelID, usable)) return true;
  }
  return !sawMember;
};

export const buildCanonicalToAliasMap = (
  enrichment: OmniRouteEnrichmentMap | undefined,
): Map<string, string> => {
  const out = new Map<string, string>();
  if (!enrichment) return out;
  for (const entry of enrichment.values()) {
    const alias = typeof entry.providerAlias === "string" ? entry.providerAlias.trim() : "";
    const canonical =
      typeof entry.providerCanonical === "string" ? entry.providerCanonical.trim() : "";
    if (!alias || !canonical || alias === canonical || out.has(canonical)) continue;
    out.set(canonical, alias);
  }
  return out;
};

export const lookupEnrichment = (
  rawID: string,
  enrichment: OmniRouteEnrichmentMap | undefined,
  canonicalToAlias: ReadonlyMap<string, string>,
): OmniRouteEnrichmentEntry | undefined => {
  if (!enrichment) return undefined;
  const direct = enrichment.get(rawID);
  if (direct) return direct;
  const slash = rawID.indexOf("/");
  if (slash <= 0) return undefined;
  const alias = canonicalToAlias.get(rawID.slice(0, slash));
  if (alias) {
    const viaAlias = enrichment.get(`${alias}${rawID.slice(slash)}`);
    if (viaAlias) return viaAlias;
  }
  return enrichment.get(rawID.slice(slash + 1));
};

/**
 * Canonical twins (`claude/x`) are dropped only when the alias twin
 * (`cc/x`) is actually present; unrelated same-suffix models are kept.
 */
export const canonicalDedupSet = (
  ids: readonly string[],
  canonicalToAlias: ReadonlyMap<string, string>,
): ReadonlySet<string> => {
  const drop = new Set<string>();
  if (canonicalToAlias.size === 0) return drop;
  const present = new Set(ids);
  for (const id of ids) {
    const slash = id.indexOf("/");
    if (slash <= 0) continue;
    const alias = canonicalToAlias.get(id.slice(0, slash));
    if (!alias) continue;
    if (present.has(`${alias}${id.slice(slash)}`)) drop.add(id);
  }
  return drop;
};

const shortProviderLabel = (entry: OmniRouteEnrichmentEntry | undefined): string | undefined => {
  if (!entry) return undefined;
  const display =
    typeof entry.providerDisplayName === "string" ? entry.providerDisplayName.trim() : "";
  if (display.length > 0 && display.length <= 12) return display;
  const alias = typeof entry.providerAlias === "string" ? entry.providerAlias.trim() : "";
  if (alias.length > 0) {
    return alias.length <= 5
      ? alias.toUpperCase()
      : alias.charAt(0).toUpperCase() + alias.slice(1).toLowerCase();
  }
  return display.length > 0 ? display : undefined;
};

const stripFreeSuffix = (name: string): { base: string; wasFree: boolean } => {
  const cleaned = name
    .replace(/\s{0,8}\(free\)\s{0,8}$/iu, "")
    .replace(/[\s-]{1,8}free\s{0,8}$/iu, "")
    .trim();
  return { base: cleaned, wasFree: cleaned.length < name.trim().length };
};

const formatTokens = (value: number): string => {
  const units: ReadonlyArray<readonly [number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (let index = 0; index < units.length; index += 1) {
    const [scale, suffix] = units[index] as readonly [number, string];
    if (value < scale) continue;
    const rendered = Number((value / scale).toFixed(1));
    if (rendered < 1000 || index === 0) return `${rendered}${suffix}`;
    const [nextScale, nextSuffix] = units[index - 1] as readonly [number, string];
    return `${Number((value / nextScale).toFixed(1))}${nextSuffix}`;
  }
  return String(value);
};

const freeBudgetSuffix = (entry: OmniRouteEnrichmentEntry): string => {
  switch (entry.freeType) {
    case "recurring-daily":
      return `${formatTokens(entry.monthlyTokens ?? 0)} tokens/day`;
    case "recurring-monthly":
      return `${formatTokens(entry.monthlyTokens ?? 0)} tokens/month`;
    case "recurring-credit":
      return `${formatTokens(entry.creditTokens ?? 0)} credits`;
    case "one-time-initial":
      return `${formatTokens(entry.creditTokens ?? 0)} credits (one-time)`;
    case "keyless":
      return "(keyless)";
    case "discontinued":
      return "(discontinued)";
    default:
      return "";
  }
};

export const capitalizeVariant = (variant: string): string =>
  variant.length === 0 ? variant : variant.charAt(0).toUpperCase() + variant.slice(1);

export const autoComboName = (id: string, candidateCount: number | undefined): string => {
  let variant = "Default";
  if (id !== "auto" && id.startsWith("auto/")) {
    const rest = id.slice("auto/".length);
    if (rest.length > 0) variant = capitalizeVariant(rest);
  } else if (id !== "auto") {
    variant = id;
  }
  const count =
    typeof candidateCount === "number" && candidateCount > 0 ? ` (${candidateCount}p)` : "";
  return `Auto: ${variant}${count}`;
};

export type DisplayNameInput = {
  readonly rawID: string;
  readonly enrichment: OmniRouteEnrichmentEntry | undefined;
  readonly providerTag: boolean;
  readonly isCombo?: boolean;
  readonly isAutoCombo?: boolean;
  readonly autoCandidateCount?: number;
};

export const buildDisplayName = (input: DisplayNameInput): string => {
  if (input.isAutoCombo) return autoComboName(input.rawID, input.autoCandidateCount);
  const enrichmentName =
    input.enrichment?.name && input.enrichment.name.trim().length > 0
      ? input.enrichment.name.trim()
      : input.rawID;
  if (input.isCombo) return `Combo: ${enrichmentName}`;
  const { base, wasFree } = stripFreeSuffix(enrichmentName);
  let name = base;
  if (input.providerTag) {
    const label = shortProviderLabel(input.enrichment);
    if (label) {
      const prefix = `${label} - `;
      if (!name.startsWith(prefix)) name = `${prefix}${name}`;
    }
  }
  const isFree = input.enrichment?.freeType !== undefined || wasFree;
  if (isFree) name = `[Free] ${name}`;
  if (isFree && input.enrichment?.freeType !== undefined) {
    const budget = freeBudgetSuffix(input.enrichment);
    if (budget) name = `${name} · ${budget}`;
  }
  return name;
};

export const resolveTransport = (modelID: string, format: ApiFormat): string => {
  if (!format.allowAnthropic) return OMNIROUTE_OPENAI_PACKAGE;
  if (format.anthropicModels.includes(modelID)) return OMNIROUTE_ANTHROPIC_PACKAGE;
  const slash = modelID.indexOf("/");
  const prefix = slash < 0 ? modelID : modelID.slice(0, slash);
  // An explicit prefix list (even empty) wins; otherwise the default
  // compatibility prefixes keep copied configs routing.
  const prefixes = format.anthropicPrefixes ?? [...DEFAULT_ANTHROPIC_PREFIXES];
  return prefixes.includes(prefix) ? OMNIROUTE_ANTHROPIC_PACKAGE : OMNIROUTE_OPENAI_PACKAGE;
};

const effortTiers = (entry: OmniRouteRawModelEntry): string[] => {
  const tiers = entry.capabilities?.effort_tiers;
  if (!Array.isArray(tiers)) return [];
  const seen = new Set<string>();
  for (const tier of tiers) {
    if (typeof tier !== "string" || tier.length === 0 || tier.length > 64) continue;
    if (!/^[A-Za-z0-9._-]+$/u.test(tier) || seen.has(tier)) continue;
    seen.add(tier);
  }
  return [...seen];
};

const reasoningVariants = (
  entry: OmniRouteRawModelEntry,
): Array<{ id: string; settings: { reasoningEffort: string } }> => {
  const tiers = effortTiers(entry);
  if (tiers.length > 0) {
    return tiers.map((tier) => ({ id: tier, settings: { reasoningEffort: tier } }));
  }
  const reasoning =
    entry.capabilities?.reasoning === true || entry.capabilities?.thinking === true;
  if (!reasoning) return [];
  return FALLBACK_EFFORTS.map((effort) => ({ id: effort, settings: { reasoningEffort: effort } }));
};

const modelCost = (
  enrichment: OmniRouteEnrichmentEntry | undefined,
): Model.Info["cost"] => {
  const pricing = enrichment?.pricing;
  if (!pricing) return [];
  const defined = (value: number | undefined): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (
    !defined(pricing.input) &&
    !defined(pricing.output) &&
    !defined(pricing.cacheRead) &&
    !defined(pricing.cacheWrite)
  ) {
    return [];
  }
  return [
    {
      input: pricing.input ?? 0,
      output: pricing.output ?? 0,
      cache: { read: pricing.cacheRead ?? 0, write: pricing.cacheWrite ?? 0 },
    },
  ] as unknown as Model.Info["cost"];
};

export type MapContext = {
  readonly providerID: string;
  readonly format: ApiFormat;
  readonly providerTag: boolean;
  readonly enrichment: OmniRouteEnrichmentMap | undefined;
  readonly canonicalToAlias: ReadonlyMap<string, string>;
};

const enrichModel = (
  info: Model.Info,
  rawID: string,
  context: MapContext,
  extra: { readonly isCombo?: boolean; readonly isAutoCombo?: boolean; readonly autoCandidateCount?: number },
): void => {
  const overlay = lookupEnrichment(rawID, context.enrichment, context.canonicalToAlias);
  const mutable = info as unknown as {
    name: string;
    cost: Model.Info["cost"];
  };
  mutable.name = buildDisplayName({
    rawID: mutable.name,
    enrichment: overlay,
    providerTag: context.providerTag,
    ...extra,
  });
  const cost = modelCost(overlay);
  if (cost.length > 0) mutable.cost = cost;
};

export const mapRawModel = (entry: OmniRouteRawModelEntry, context: MapContext): Model.Info => {
  const capabilities: NonNullable<OmniRouteRawModelEntry["capabilities"]> =
    entry.capabilities ?? {};
  const tools = capabilities.tool_calling === true;
  const attachment = capabilities.attachment === true || capabilities.vision === true;
  const input = modalityList(entry.input_modalities, attachment ? ["text", "image"] : ["text"]);
  const output = modalityList(entry.output_modalities, ["text"]);
  const info = {
    id: entry.id,
    modelID: entry.id,
    providerID: context.providerID,
    name: entry.id,
    package: resolveTransport(entry.id, context.format),
    capabilities: { tools, input, output },
    variants: reasoningVariants(entry),
    time: { released: releasedAt(entry.release_date) },
    cost: [],
    status: "active",
    enabled: true,
    limit: {
      context: positiveInt(entry.context_length) ?? DEFAULT_CONTEXT_LIMIT,
      ...(positiveInt(entry.max_input_tokens) === undefined
        ? {}
        : { input: positiveInt(entry.max_input_tokens) as number }),
      output: positiveInt(entry.max_output_tokens) ?? DEFAULT_OUTPUT_LIMIT,
    },
  } as unknown as Model.Info;
  enrichModel(info, entry.id, context, {});
  return info;
};

type ComboMember = {
  readonly context?: number;
  readonly input?: number;
  readonly output?: number;
  readonly tools: boolean;
  readonly reasoning: boolean;
  readonly attachment: boolean;
  readonly temperature: boolean;
  readonly thinking: boolean;
  readonly inMods: ReadonlySet<string>;
  readonly outMods: ReadonlySet<string>;
};

const memberOf = (entry: OmniRouteRawModelEntry): ComboMember => {
  const capabilities: NonNullable<OmniRouteRawModelEntry["capabilities"]> =
    entry.capabilities ?? {};
  return {
    context: positiveInt(entry.context_length),
    input: positiveInt(entry.max_input_tokens),
    output: positiveInt(entry.max_output_tokens),
    tools: capabilities.tool_calling === true,
    reasoning: capabilities.reasoning === true || capabilities.thinking === true,
    attachment: capabilities.attachment === true || capabilities.vision === true,
    temperature: capabilities.temperature !== false,
    thinking: capabilities.thinking === true,
    inMods: new Set(modalityList(entry.input_modalities, ["text"])),
    outMods: new Set(modalityList(entry.output_modalities, ["text"])),
  };
};

const minOf = (values: Array<number | undefined>): number | undefined => {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
};

export const mapCombo = (
  combo: OmniRouteRawCombo,
  comboID: string,
  members: readonly OmniRouteRawModelEntry[],
  context: MapContext,
): Model.Info => {
  const parsed = members.map(memberOf);
  const hasMembers = parsed.length > 0;
  const allHave = (pick: (member: ComboMember) => boolean): boolean =>
    hasMembers && parsed.every(pick);
  const modality = (sets: ReadonlyArray<ReadonlySet<string>>, key: string): boolean =>
    hasMembers && sets.every((set) => set.has(key));
  const inSets = parsed.map((member) => member.inMods);
  const outSets = parsed.map((member) => member.outMods);
  const everyInput = hasMembers && parsed.every((member) => member.input !== undefined);
  const serverContext = positiveInt(combo.computed_context_length);
  const info = {
    id: comboID,
    modelID: comboID,
    providerID: context.providerID,
    name: typeof combo.name === "string" && combo.name.trim().length > 0 ? combo.name.trim() : comboID,
    package: OMNIROUTE_OPENAI_PACKAGE,
    capabilities: {
      tools: allHave((member) => member.tools),
      input: ["text", "image", "audio", "video", "pdf"].filter((key) => modality(inSets, key)),
      output: ["text", "image", "audio", "video", "pdf"].filter((key) => modality(outSets, key)),
    },
    variants: [],
    time: { released: releasedAt(combo.release_date) },
    cost: [],
    status: "active",
    enabled: true,
    limit: {
      context:
        serverContext ?? minOf(parsed.map((member) => member.context)) ?? DEFAULT_CONTEXT_LIMIT,
      ...(everyInput ? { input: minOf(parsed.map((member) => member.input)) as number } : {}),
      output: minOf(parsed.map((member) => member.output)) ?? DEFAULT_OUTPUT_LIMIT,
    },
  } as unknown as Model.Info;
  // A combo spanning providers stays on the OpenAI-compatible transport unless
  // every member resolves to Anthropic.
  if (hasMembers && members.every((member) => resolveTransport(member.id, context.format) === OMNIROUTE_ANTHROPIC_PACKAGE)) {
    (info as unknown as { package: string }).package = OMNIROUTE_ANTHROPIC_PACKAGE;
  }
  enrichModel(info, combo.id, context, { isCombo: true });
  // Combo names stay distinguishable in the picker.
  const mutable = info as unknown as { name: string };
  if (!mutable.name.startsWith("Combo: ")) mutable.name = `Combo: ${mutable.name}`;
  return info;
};

export const mapAutoCombo = (
  combo: OmniRouteRawAutoCombo,
  context: MapContext,
): Model.Info => {
  const candidateCount =
    typeof combo.candidateCount === "number" &&
    Number.isSafeInteger(combo.candidateCount) &&
    combo.candidateCount > 0
      ? combo.candidateCount
      : undefined;
  const info = {
    id: combo.id,
    modelID: combo.id,
    providerID: context.providerID,
    name: combo.id,
    package: resolveTransport(combo.id, context.format),
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: {
      context: positiveInt(combo.context_length) ?? AUTO_COMBO_FALLBACK_CONTEXT,
      output: positiveInt(combo.max_output_tokens) ?? AUTO_COMBO_FALLBACK_OUTPUT,
    },
  } as unknown as Model.Info;
  enrichModel(info, combo.id, context, { isAutoCombo: true, autoCandidateCount: candidateCount });
  return info;
};

export type CatalogSnapshot = {
  readonly models: readonly OmniRouteRawModelEntry[];
  readonly combos: readonly OmniRouteRawCombo[];
  readonly autoCombos: readonly OmniRouteRawAutoCombo[];
};

export type BuildOptions = {
  readonly providerID: string;
  readonly format: ApiFormat;
  readonly providerTag: boolean;
  readonly enrichment: OmniRouteEnrichmentMap | undefined;
  readonly usable: UsableProviderSet | undefined;
  readonly visible: ModelListFilter | undefined;
  readonly hidden: ModelListFilter | undefined;
  readonly warn?: (message: string) => void;
  readonly warnedKeys?: Set<string>;
};

export type BuiltCatalog = {
  readonly entries: Model.Info[];
  readonly modelCount: number;
  readonly comboCount: number;
  readonly autoComboCount: number;
  readonly droppedUnresolvedCombos: number;
};

const safeWarn = (warn: ((message: string) => void) | undefined, message: string): void => {
  try {
    warn?.(message);
  } catch {
    // Observability must never break catalog assembly.
  }
};

const comboDisplayID = (combo: OmniRouteRawCombo): string | undefined => {
  if (typeof combo.id !== "string" || !isModelID(combo.id)) return undefined;
  return combo.id;
};

/**
 * Resolve nested combo-refs with a bounded fixpoint: each pass resolves
 * combos whose nested refs already resolved. Cycles and dangling refs never
 * resolve and are dropped instead of published with invented capabilities.
 */
export const buildCatalog = (snapshot: CatalogSnapshot, options: BuildOptions): BuiltCatalog => {
  const canonicalToAlias = buildCanonicalToAliasMap(options.enrichment);
  const context: MapContext = {
    providerID: options.providerID,
    format: options.format,
    providerTag: options.providerTag,
    enrichment: options.enrichment,
    canonicalToAlias,
  };
  const entries: Model.Info[] = [];
  const published = new Set<string>();
  const rawByID = new Map<string, OmniRouteRawModelEntry>();
  for (const entry of snapshot.models) {
    if (entry && typeof entry.id === "string" && isModelID(entry.id) && !rawByID.has(entry.id)) {
      rawByID.set(entry.id, entry);
    }
  }
  const twins = canonicalDedupSet([...rawByID.keys()], canonicalToAlias);

  let modelCount = 0;
  for (const entry of rawByID.values()) {
    if (twins.has(entry.id)) continue;
    if (!isUsableModelID(entry.id, options.usable)) continue;
    if (!passesVisibility(entry.id, options.visible, options.hidden)) continue;
    entries.push(mapRawModel(entry, context));
    published.add(entry.id);
    modelCount += 1;
  }

  const warned = options.warnedKeys ?? new Set<string>();
  const resolvedCombos = new Map<string, OmniRouteRawModelEntry[]>();
  const pending = snapshot.combos.filter((combo) => {
    if (!combo || typeof combo !== "object") return false;
    if (comboDisplayID(combo) === undefined) return false;
    if (combo.isHidden === true) return false;
    if (!isUsableCombo(combo, options.usable)) return false;
    if (!passesComboVisibility(combo, combo.id, options.visible, options.hidden)) return false;
    return true;
  });

  let comboCount = 0;
  let remaining = [...pending];
  for (let pass = 0; pass < MAX_COMBO_PASSES && remaining.length > 0; pass += 1) {
    const deferred: OmniRouteRawCombo[] = [];
    for (const combo of remaining) {
      const comboID = combo.id;
      const members: OmniRouteRawModelEntry[] = [];
      let blocked = false;
      for (const step of comboSteps(combo)) {
        if (isComboRef(step)) {
          const refName = typeof step.comboName === "string" ? step.comboName : "";
          const nested = refName ? resolvedCombos.get(refName) : undefined;
          if (!nested) {
            blocked = true;
            break;
          }
          members.push(...nested);
          continue;
        }
        const modelID = stepModelID(step);
        if (!modelID) continue;
        const member = rawByID.get(modelID);
        if (member) members.push(member);
      }
      if (blocked) {
        deferred.push(combo);
        continue;
      }
      const friendly =
        typeof combo.name === "string" && combo.name.trim().length > 0
          ? combo.name.trim()
          : comboID;
      if (published.has(comboID)) {
        const dedupeKey = `${options.providerID}::${comboID}`;
        if (!warned.has(dedupeKey)) {
          warned.add(dedupeKey);
          safeWarn(
            options.warn,
            `opencode-9router-v2: omniroute combo "${comboID}" collides with a model id; combo wins`,
          );
        }
        const index = entries.findIndex(
          (entry) => (entry as unknown as { id: string }).id === comboID,
        );
        if (index >= 0) entries.splice(index, 1);
      }
      entries.push(mapCombo(combo, comboID, members, context));
      published.add(comboID);
      comboCount += 1;
      if (!resolvedCombos.has(friendly)) resolvedCombos.set(friendly, members);
    }
    if (deferred.length === remaining.length) {
      remaining = deferred;
      break;
    }
    remaining = deferred;
  }
  const droppedUnresolvedCombos = remaining.length;
  if (droppedUnresolvedCombos > 0) {
    safeWarn(
      options.warn,
      `opencode-9router-v2: omniroute dropped ${droppedUnresolvedCombos} combo(s) with unresolvable members`,
    );
  }

  let autoComboCount = 0;
  for (const combo of snapshot.autoCombos) {
    if (!combo || typeof combo !== "object") continue;
    if (typeof combo.id !== "string" || !isModelID(combo.id)) continue;
    if (combo.isHidden === true) continue;
    if (!passesVisibility(combo.id, options.visible, options.hidden)) continue;
    if (!isUsableModelID(combo.id, options.usable)) continue;
    if (published.has(combo.id)) {
      const dedupeKey = `${options.providerID}::${combo.id}`;
      if (!warned.has(dedupeKey)) {
        warned.add(dedupeKey);
        safeWarn(
          options.warn,
          `opencode-9router-v2: omniroute auto combo "${combo.id}" collides with a model id; auto combo wins`,
        );
      }
      const index = entries.findIndex(
        (entry) => (entry as unknown as { id: string }).id === combo.id,
      );
      if (index >= 0) entries.splice(index, 1);
    }
    entries.push(mapAutoCombo(combo, context));
    published.add(combo.id);
    autoComboCount += 1;
  }

  return { entries, modelCount, comboCount, autoComboCount, droppedUnresolvedCombos };
};

export const parseModelsPayload = (payload: unknown): OmniRouteRawModelEntry[] => {
  const data: unknown[] = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data as unknown[])
      : [];
  const out: OmniRouteRawModelEntry[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const entry = item as OmniRouteRawModelEntry;
    if (!isModelID(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
};

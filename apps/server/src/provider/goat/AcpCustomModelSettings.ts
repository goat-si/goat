// @effect-diagnostics nodeBuiltinImport:off -- compare only the changed provider settings.
import * as NodeUtil from "node:util";
import {
  CustomModelEntry,
  CustomModelSetting,
  ProviderInstanceId,
  ServerSettingsError,
  type ServerSettings,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeModels = Schema.decodeUnknownSync(Schema.Array(CustomModelSetting));
const decodeDetails = Schema.decodeUnknownSync(Schema.Array(CustomModelEntry));
const strict = { onExcessProperty: "error" } as const;

function normalizeConfig(value: unknown, previous: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const config = value as Record<string, unknown>;
  if (!("customModels" in config) && !("customModelDetails" in config)) return value;
  const models = decodeModels(config.customModels ?? [], strict);
  const ids = models.map((model) => (typeof model === "string" ? model : model.slug));
  const fromLegacy = models.filter((model) => typeof model !== "string");
  const explicitDetails =
    config.customModelDetails === undefined ? [] : decodeDetails(config.customModelDetails, strict);
  const prior =
    previous !== null && typeof previous === "object" && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : {};
  const detailsUnchanged = NodeUtil.isDeepStrictEqual(
    prior.customModelDetails,
    config.customModelDetails,
  );
  const legacyUpdate =
    fromLegacy.length > 0 ||
    (detailsUnchanged && !NodeUtil.isDeepStrictEqual(prior.customModels, config.customModels));
  const idsSet = new Set(ids);
  const existingDetails = new Map<string, (typeof explicitDetails)[number]>();
  for (const entry of explicitDetails) {
    if (existingDetails.has(entry.slug) || (!idsSet.has(entry.slug) && !detailsUnchanged)) {
      throw new Error("Model detail does not match a unique model ID");
    }
    existingDetails.set(entry.slug, entry);
  }
  const details = legacyUpdate
    ? models.flatMap((model) => {
        const entry = typeof model === "string" ? existingDetails.get(model) : model;
        return entry === undefined ? [] : [entry];
      })
    : explicitDetails;
  const seen = new Set<string>();
  for (const entry of details) {
    if (!idsSet.has(entry.slug) || seen.has(entry.slug))
      throw new Error("Model detail does not match a unique model ID");
    seen.add(entry.slug);
  }
  const { customModelDetails: _oldDetails, ...rest } = config;
  return {
    ...rest,
    customModels: ids,
    ...(details.length === 0 ? {} : { customModelDetails: details }),
  };
}

export const normalizeChangedAcpCustomModels = (
  current: ServerSettings,
  next: ServerSettings,
  settingsPath: string,
) =>
  Effect.try({
    try: () => {
      const instances = { ...next.providerInstances };
      for (const [rawId, instance] of Object.entries(next.providerInstances)) {
        const id = ProviderInstanceId.make(rawId);
        if (instance.driver !== "acpRegistry") continue;
        const rawConfig = instance.config;
        const legacyObjects =
          rawConfig !== null &&
          typeof rawConfig === "object" &&
          !Array.isArray(rawConfig) &&
          Array.isArray((rawConfig as Record<string, unknown>).customModels) &&
          ((rawConfig as Record<string, unknown>).customModels as ReadonlyArray<unknown>).some(
            (entry) => typeof entry !== "string",
          );
        if (!legacyObjects && NodeUtil.isDeepStrictEqual(current.providerInstances[id], instance))
          continue;
        instances[id] = {
          ...instance,
          ...(instance.config === undefined
            ? {}
            : { config: normalizeConfig(instance.config, current.providerInstances[id]?.config) }),
        };
      }
      return { ...next, providerInstances: instances };
    },
    catch: (cause) =>
      new ServerSettingsError({
        settingsPath,
        operation: "normalize",
        reason: "Invalid ACP custom model settings. Check model IDs, names, and options.",
        cause,
      }),
  });

import {
  readCustomModelEntries,
  toCustomModelSetting,
  type CustomModelDefinition,
} from "@goat/shared/model";
import { nextConfigBlobWithValue } from "./ProviderConfigValue";

const NO_CUSTOM_MODELS: ReadonlyArray<CustomModelDefinition> = [];

const asConfig = (config: unknown): Record<string, unknown> =>
  config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};

export function encodeAcpCustomModels(
  config: unknown,
  models: ReadonlyArray<CustomModelDefinition>,
  supported: boolean,
): Record<string, unknown> {
  const result = asConfig(config);
  result.customModels = models.map((entry) => entry.slug);
  if (supported) {
    result.customModelDetails = models.map((entry) => {
      const value = toCustomModelSetting(entry);
      return typeof value === "string" ? { slug: value } : value;
    });
  } else {
    delete result.customModelDetails;
  }
  return result;
}

export function readAcpCustomModels(config: unknown, supported: boolean): CustomModelDefinition[] {
  const value = asConfig(config);
  const models = readCustomModelEntries(value.customModels);
  if (!supported) return models;
  const details = new Map(
    readCustomModelEntries(value.customModelDetails).map((entry) => [entry.slug, entry]),
  );
  return models.map((entry) => details.get(entry.slug) ?? entry);
}

export function readProviderCustomModels(
  driver: string,
  config: unknown,
  supported: boolean,
): ReadonlyArray<CustomModelDefinition> {
  if (driver === "antigravity") return NO_CUSTOM_MODELS;
  return driver === "acpRegistry"
    ? readAcpCustomModels(config, supported)
    : readCustomModelEntries(asConfig(config).customModels);
}

export function writeProviderCustomModels(
  driver: string,
  config: unknown,
  models: ReadonlyArray<CustomModelDefinition>,
  supported: boolean,
): Record<string, unknown> {
  return driver === "acpRegistry"
    ? encodeAcpCustomModels(config, models, supported)
    : nextConfigBlobWithValue(config, "customModels", models.map(toCustomModelSetting));
}

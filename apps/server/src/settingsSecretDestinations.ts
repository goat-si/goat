import {
  isSecretReference,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@goat/contracts";
import { providerConfigSecret } from "./provider/providerConfigSecrets.ts";
import { SECRET_REDACTED } from "./settingsSecrets.ts";

const sameReference = (left: unknown, right: unknown) =>
  isSecretReference(left) &&
  isSecretReference(right) &&
  left.provider === right.provider &&
  left.reference === right.reference;
const kept = (previous: unknown, next: unknown) =>
  next === SECRET_REDACTED || sameReference(previous, next);

const driverDestinationKeys: Readonly<Record<string, ReadonlyArray<string>>> = {
  codex: ["modelRoute", "opencodexBaseUrl"],
  claudeAgent: ["modelRoute", "opencodexBaseUrl"],
  cursor: ["apiEndpoint"],
  opencode: ["serverUrl"],
  antigravity: ["authMethod", "gcpProject", "gcpLocation"],
  acpRegistry: ["commandPath"],
  fx: [],
  grok: [],
  muse: [],
  pi: [],
};
const destinationKey = /(?:url|host|endpoint)$|base.?url/i;
const destinationEnv = /(?:_URL|_HOST|_ENDPOINT)$|BASE_URL/i;

function providerDestination(instance: ProviderInstanceConfig): string | null {
  const config: Array<readonly [string, unknown]> = [];
  const pending: Array<readonly [unknown, string]> = [[instance.config, ""]];
  const seen = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (item === undefined) break;
    const [value, prefix] = item;
    if (!value || typeof value !== "object") continue;
    if (seen.has(value) || seen.size >= 10_000) return null;
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (
        destinationKey.test(key) ||
        key === "binaryPath" ||
        key === "commandPath" ||
        (driverDestinationKeys[instance.driver]?.includes(key) ?? false)
      ) {
        if (entry !== null && typeof entry === "object") return null;
        config.push([name, entry]);
      } else {
        pending.push([entry, name]);
        if (pending.length > 10_000) return null;
      }
    }
  }
  config.sort(([left], [right]) => left.localeCompare(right));
  const environment = (instance.environment ?? [])
    .filter((entry) => destinationEnv.test(entry.name))
    .map((entry) => [entry.name, entry.value, entry.secret] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([instance.driver, config, environment]);
}

function clearProviderReferences(
  previous: ProviderInstanceConfig,
  next: ProviderInstanceConfig,
): ProviderInstanceConfig {
  const before = providerDestination(previous);
  const priorConfig = providerConfigSecret(previous);
  const nextConfig =
    next.config && typeof next.config === "object" && !Array.isArray(next.config)
      ? (next.config as Record<string, unknown>)
      : undefined;
  if (before !== null && before === providerDestination(next)) {
    return priorConfig && nextConfig?.[priorConfig.field] === SECRET_REDACTED
      ? { ...next, config: { ...nextConfig, [priorConfig.field]: priorConfig.reference } }
      : next;
  }
  const previousEnv = new Map(
    (previous.environment ?? []).map((entry) => [entry.name, entry.secret]),
  );
  const environment = next.environment?.map((entry) => {
    if (!sameReference(previousEnv.get(entry.name), entry.secret)) return entry;
    const { secret: _secret, valueRedacted: _redacted, ...rest } = entry;
    return { ...rest, value: "" };
  });
  const config =
    priorConfig && nextConfig && kept(priorConfig.reference, nextConfig[priorConfig.field])
      ? { ...nextConfig, [priorConfig.field]: "" }
      : next.config;
  return {
    ...next,
    ...(environment === undefined ? {} : { environment }),
    ...(config === undefined ? {} : { config }),
  };
}

export function clearRetargetedSettingsSecrets(
  current: ServerSettings,
  next: ServerSettings,
): ServerSettings {
  const textGenerators = Object.fromEntries(
    Object.entries(next.textGenerators).map(([id, generator]) => {
      const old = current.textGenerators[id as keyof typeof current.textGenerators];
      const moved = old && (old.baseUrl !== generator.baseUrl || old.kind !== generator.kind);
      if (old && !moved && generator.apiKey === SECRET_REDACTED && isSecretReference(old.apiKey)) {
        return [id, { ...generator, apiKey: old.apiKey }];
      }
      return [
        id,
        old && moved && kept(old.apiKey, generator.apiKey)
          ? { ...generator, apiKey: "" }
          : generator,
      ];
    }),
  ) as ServerSettings["textGenerators"];
  const usageLimitSources = Object.fromEntries(
    Object.entries(next.usageLimitSources).map(([id, source]) => {
      const old = current.usageLimitSources[id as keyof typeof current.usageLimitSources];
      if (!old || old.url === source.url) return [id, source];
      const referenceKept = sameReference(
        old.managementKeyReference,
        source.managementKeyReference,
      );
      const literalKept = source.managementKey === SECRET_REDACTED;
      return [
        id,
        referenceKept || literalKept
          ? {
              ...source,
              ...(referenceKept ? { managementKeyReference: null } : {}),
              ...(literalKept ? { managementKey: "" } : {}),
            }
          : source,
      ];
    }),
  ) as ServerSettings["usageLimitSources"];
  const providerInstances = Object.fromEntries(
    Object.entries(next.providerInstances).map(([id, instance]) => {
      const previous = current.providerInstances[id as keyof typeof current.providerInstances];
      return [id, previous ? clearProviderReferences(previous, instance) : instance];
    }),
  ) as ServerSettings["providerInstances"];
  return { ...next, textGenerators, usageLimitSources, providerInstances };
}

import {
  isSecretReference,
  type ProviderInstanceConfig,
  type SecretReference,
} from "@goat/contracts";

export function providerConfigSecret(
  entry: ProviderInstanceConfig,
): { field: string; reference: SecretReference } | undefined {
  const field =
    entry.driver === "antigravity"
      ? "apiKey"
      : entry.driver === "opencode"
        ? "serverPassword"
        : undefined;
  if (!field || !entry.config || typeof entry.config !== "object" || Array.isArray(entry.config))
    return undefined;
  const value = (entry.config as Record<string, unknown>)[field];
  return isSecretReference(value) ? { field, reference: value } : undefined;
}

export function providerSecretReferences(
  entry: ProviderInstanceConfig,
): ReadonlyArray<SecretReference> {
  const config = providerConfigSecret(entry);
  return [
    ...(entry.environment ?? []).flatMap((variable) => (variable.secret ? [variable.secret] : [])),
    ...(config ? [config.reference] : []),
  ];
}

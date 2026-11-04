import type { ProviderInstanceConfig } from "@goat/contracts";

export function preserveSecretReferences(
  previous: ProviderInstanceConfig | undefined,
  next: ProviderInstanceConfig,
): ProviderInstanceConfig {
  if (!previous?.environment || !next.environment) return next;
  const references = new Map(
    previous.environment.flatMap((variable) =>
      variable.secret ? [[variable.name, variable.secret] as const] : [],
    ),
  );
  return {
    ...next,
    environment: next.environment.map((variable) => {
      const secret = references.get(variable.name);
      return secret &&
        variable.secret === undefined &&
        variable.value === "" &&
        variable.valueRedacted === undefined
        ? { ...variable, secret }
        : variable;
    }),
  };
}

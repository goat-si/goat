import { isSecretReference } from "@goat/contracts";

const tokenMap = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !isSecretReference(value);

const normalized = (value: unknown) =>
  Object.fromEntries(
    Object.entries(tokenMap(value) ? value : {}).map(([host, token]) => [
      host.trim().toLowerCase(),
      token,
    ]),
  );

export function mergeSourceControlHostSettings(
  saved: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
) {
  return {
    ...saved,
    ...patch,
    ...(tokenMap(patch.tokens) && Object.keys(patch.tokens).length > 0
      ? { tokens: { ...normalized(saved?.tokens), ...normalized(patch.tokens) } }
      : {}),
  };
}

export function sourceControlTokenPatch(
  kind: string,
  host: string,
  token: string | import("@goat/contracts").SecretReference,
) {
  return { sourceControlHosts: { [kind]: { tokens: { [host]: token } } } };
}

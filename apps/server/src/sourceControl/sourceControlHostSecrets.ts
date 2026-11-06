import {
  isSecretReference,
  secretSettingsFields,
  type SecretReference,
  type ServerSettings,
} from "@goat/contracts";

import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";

export const SOURCE_CONTROL_HOST_SECRET_FIELDS: ReadonlyMap<
  string,
  ReadonlyArray<string>
> = new Map(
  sourceControlDefinitions.definitions.flatMap((definition) => {
    const fields = definition.settings ? secretSettingsFields(definition.settings) : [];
    return fields.length > 0 ? [[definition.kind, fields] as const] : [];
  }),
);

export interface SourceControlHostSecretSlot {
  readonly kind: string;
  readonly field: string;
  readonly serverHost: string | null;
}

/** The secret store entry for one slot; names stay stable across releases. */
export function sourceControlHostSecretName(slot: SourceControlHostSecretSlot): string {
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return slot.serverHost === null
    ? `source-control-${encode(slot.kind)}-${encode(slot.field)}`
    : `source-control-${encode(slot.kind)}-${encode(slot.field)}-${encode(slot.serverHost.trim().toLowerCase())}`;
}

export function readSecretFieldValues(
  value: unknown,
): ReadonlyArray<readonly [serverHost: string | null, value: string]> {
  if (isSecretReference(value)) return [];
  if (typeof value === "string") return [[null, value]];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([serverHost, entry]) =>
    typeof entry === "string" ? [[serverHost.trim().toLowerCase(), entry] as const] : [],
  );
}

export function writeSecretFieldValues(
  original: unknown,
  values: ReadonlyArray<readonly [serverHost: string | null, value: string]>,
): unknown {
  if (isSecretReference(original))
    return { provider: original.provider, reference: original.reference };
  if (typeof original === "string") return values[0]?.[1] ?? "";
  const references =
    original !== null && typeof original === "object" && !Array.isArray(original)
      ? Object.entries(original).flatMap(([host, value]) =>
          isSecretReference(value)
            ? [
                [
                  host.trim().toLowerCase(),
                  { provider: value.provider, reference: value.reference },
                ] as const,
              ]
            : [],
        )
      : [];
  return Object.fromEntries([
    ...references,
    ...values.map(
      ([serverHost, value]) => [serverHost?.trim().toLowerCase() ?? "", value] as const,
    ),
  ]);
}

export async function resolveHostSecrets(
  settings: ServerSettings,
  kind: string,
  host: string | undefined,
  read: (reference: SecretReference) => Promise<string>,
): Promise<ServerSettings> {
  const original = settings.sourceControlHosts[kind];
  if (!original) return settings;
  const fields = { ...original };
  try {
    for (const name of SOURCE_CONTROL_HOST_SECRET_FIELDS.get(kind) ?? []) {
      const value = fields[name];
      if (isSecretReference(value)) {
        fields[name] = await read(value);
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        const entries: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
          entries[key] = isSecretReference(entry)
            ? host !== undefined && key.toLowerCase() === host.toLowerCase()
              ? await read(entry)
              : ""
            : entry;
        }
        fields[name] = entries;
      }
    }
  } catch {
    throw new Error("Could not resolve source control credential");
  }
  return { ...settings, sourceControlHosts: { ...settings.sourceControlHosts, [kind]: fields } };
}

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

export class SourceControlCredentialDestinationError extends Error {
  readonly _tag = "SourceControlCredentialDestinationError";
  readonly kind: string;
  readonly host: string;
  readonly trustedHost: string;
  constructor(kind: string, host: string, trustedHost: string) {
    const safe = (value: string) => value.replace(/[^a-zA-Z0-9.:[\]_ -]/g, "?").slice(0, 255);
    super(
      `Could not resolve source control credential: saved ${safe(kind)} credentials are only used for ${safe(trustedHost)} (requested ${safe(host)}).`,
    );
    this.kind = kind;
    this.host = host;
    this.trustedHost = trustedHost;
  }
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
  configuredHosts: ReadonlyArray<string> = [],
): Promise<ServerSettings> {
  const original = settings.sourceControlHosts[kind];
  if (!original) return settings;
  const fields = { ...original };
  const readRequired = async (reference: SecretReference) => {
    const value = await read(reference);
    if (value.trim() === "") throw new Error("Empty source control credential");
    return value;
  };
  try {
    for (const name of SOURCE_CONTROL_HOST_SECRET_FIELDS.get(kind) ?? []) {
      const value = fields[name];
      if (isSecretReference(value)) {
        const publicHost = sourceControlDefinitions.definitions.find(
          (entry) => entry.kind === kind,
        )?.publicHost;
        const builtIn =
          kind === "bitbucket" ? ["bitbucket.org", "api.bitbucket.org"] : [publicHost];
        const trusted = [...builtIn, ...configuredHosts]
          .filter((value): value is string => value != null)
          .map((value) => value.toLowerCase());
        if (host === undefined || !trusted.includes(host.toLowerCase())) {
          throw new SourceControlCredentialDestinationError(
            kind,
            host ?? "unknown host",
            trusted.join(" or ") || "its configured host",
          );
        }
        fields[name] = await readRequired(value);
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        const entries: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
          entries[key] = isSecretReference(entry)
            ? host !== undefined && key.toLowerCase() === host.toLowerCase()
              ? await readRequired(entry)
              : ""
            : entry;
        }
        fields[name] = entries;
      }
    }
  } catch (error) {
    if (error instanceof SourceControlCredentialDestinationError) throw error;
    throw new Error("Could not resolve source control credential");
  }
  return { ...settings, sourceControlHosts: { ...settings.sourceControlHosts, [kind]: fields } };
}

// @effect-diagnostics nodeBuiltinImport:off -- read-only local file settings under stateDir.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { AuthEnvironmentScopes, RuntimeMode, TrimmedNonEmptyString } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ChannelConnectionOwner } from "../ChannelIngressContext.ts";

export const IMESSAGE_SETTINGS_FILE = "imessage-channel-settings.json";
export const ImessageSettingsFile = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  connectionId: Schema.String,
  allowedHandles: Schema.Array(Schema.String),
  ownHandles: Schema.Array(Schema.String),
  owner: Schema.Struct({
    ownerId: TrimmedNonEmptyString,
    principalId: TrimmedNonEmptyString,
    displayName: TrimmedNonEmptyString,
    grantedScopes: AuthEnvironmentScopes,
    runtimeModeCeiling: RuntimeMode,
  }),
});
export type ImessageSettingsFile = typeof ImessageSettingsFile.Type;
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ImessageSettingsFile));

export interface ImessageSettings {
  readonly connectionId: string;
  readonly allowedHandles: ReadonlySet<string>;
  readonly ownHandles: ReadonlySet<string>;
  readonly owner: ChannelConnectionOwner;
}

export function normalizeHandle(raw: string): string | undefined {
  const value = raw.trim();
  if (/^\+[1-9]\d{5,14}$/.test(value)) return value;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return value.toLowerCase();
  return undefined;
}

export function validateImessageSettings(file: ImessageSettingsFile): ImessageSettings | undefined {
  if (
    !/^imessage-[a-f0-9]{12}$/.test(file.connectionId) ||
    file.allowedHandles.length === 0 ||
    !file.owner.grantedScopes.includes("orchestration:operate")
  )
    return undefined;
  const allowed = file.allowedHandles.map(normalizeHandle);
  const own = file.ownHandles.map(normalizeHandle);
  if (allowed.some((value) => value === undefined) || own.some((value) => value === undefined))
    return undefined;
  const allowedHandles = new Set(allowed as string[]);
  const ownHandles = new Set(own as string[]);
  if (
    allowedHandles.size !== allowed.length ||
    ownHandles.size !== own.length ||
    [...allowedHandles].some((value) => ownHandles.has(value))
  )
    return undefined;
  return { connectionId: file.connectionId, allowedHandles, ownHandles, owner: file.owner };
}

export function loadImessageSettings(input: {
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
}) {
  return Effect.gen(function* () {
    if (input.platform !== "darwin") return undefined;
    const path = NodePath.join(input.stateDir, IMESSAGE_SETTINGS_FILE);
    const source = yield* Effect.promise(async () => {
      try {
        return { type: "found" as const, value: await NodeFSP.readFile(path, "utf8") };
      } catch (cause) {
        return {
          type:
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "ENOENT"
              ? ("missing" as const)
              : ("invalid" as const),
        };
      }
    });
    if (source.type === "missing") return undefined;
    if (source.type === "invalid") {
      yield* Effect.logWarning("iMessage settings unavailable");
      return undefined;
    }
    const parsed = decode(source.value);
    if (Option.isNone(parsed)) {
      yield* Effect.logWarning("iMessage settings invalid");
      return undefined;
    }
    const file = parsed.value;
    const settings = validateImessageSettings(file);
    if (settings === undefined) yield* Effect.logWarning("iMessage settings invalid");
    return file.enabled ? settings : undefined;
  });
}

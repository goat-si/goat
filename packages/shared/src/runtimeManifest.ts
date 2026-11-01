import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CLI_ARCHIVE_PLATFORM_KEYS, cliArchiveFileName } from "./cliRelease.ts";
import {
  compareRuntimeProtocols,
  ownRuntimeProtocolRanges,
  servedRuntimeProtocolRanges,
  type RuntimeProtocolRanges,
} from "./sshRuntimeProtocol.ts";

/**
 * A reader refuses any other schema, so bump this only for a change an older reader would
 * misread. New optional fields do not need a bump.
 */
const RUNTIME_MANIFEST_SCHEMA = 1;
/** Sits at the archive root, next to the executable. */
export const RUNTIME_MANIFEST_ARCHIVE_ENTRY = "goat-runtime.json";

export function runtimeManifestAssetName(version: string): string {
  return `goat-${version}-runtime.json`;
}

/**
 * What this build's runtime can do for a client beyond its protocol ranges. `memory-scopes`:
 * `goat auth session issue` can grant `memory:*` scopes (#285).
 */
const RUNTIME_CAPABILITIES: ReadonlyArray<string> = ["memory-scopes"];
/** A runtime this client starts on its own initiative must have every one of these. */
const REQUIRED_RUNTIME_CAPABILITIES: ReadonlyArray<string> = ["memory-scopes"];

const ProtocolRange = Schema.Struct({ min: Schema.Int, max: Schema.Int });

export const RuntimeManifest = Schema.Struct({
  schema: Schema.Literal(RUNTIME_MANIFEST_SCHEMA),
  version: Schema.String,
  commit: Schema.optionalKey(Schema.String),
  commitTime: Schema.optionalKey(Schema.Int),
  /**
   * The protocols the runtime serves. A client is compatible when its own protocols fall
   * inside both ranges, so the bounds are the oldest and newest client the runtime accepts.
   */
  protocol: Schema.Struct({ ssh: ProtocolRange, orchestration: ProtocolRange }),
  capabilities: Schema.Array(Schema.String),
  /** Only in the release asset: each platform archive and its SHA-256. */
  platforms: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ asset: Schema.String, sha256: Schema.String })),
  ),
});
export type RuntimeManifest = typeof RuntimeManifest.Type;

const decodeManifestJson = Schema.decodeUnknownOption(Schema.fromJsonString(RuntimeManifest));
/** `undefined` for malformed JSON, a wrong shape, or another schema. */
export function decodeRuntimeManifest(text: string): RuntimeManifest | undefined {
  return Option.getOrUndefined(decodeManifestJson(text));
}

/** The manifest of the build this code is part of. */
export function ownRuntimeManifest(input: {
  readonly version: string;
  readonly commit?: string | undefined;
  readonly commitTime?: number | undefined;
}): RuntimeManifest {
  return {
    schema: RUNTIME_MANIFEST_SCHEMA,
    version: input.version,
    ...(input.commit === undefined ? {} : { commit: input.commit }),
    ...(input.commitTime === undefined ? {} : { commitTime: input.commitTime }),
    protocol: servedRuntimeProtocolRanges(),
    capabilities: [...RUNTIME_CAPABILITIES],
  };
}

/**
 * The release asset: the build's manifest plus every platform archive that SHA256SUMS
 * covers. Fails when the release has no archive at all.
 */
export function releaseRuntimeManifest(
  manifest: RuntimeManifest,
  checksums: ReadonlyMap<string, string>,
): RuntimeManifest {
  const platforms: Record<string, { asset: string; sha256: string }> = {};
  for (const key of CLI_ARCHIVE_PLATFORM_KEYS) {
    const asset = cliArchiveFileName(manifest.version, key);
    const sha256 = checksums.get(asset);
    if (sha256 !== undefined) platforms[key] = { asset, sha256 };
  }
  if (Object.keys(platforms).length === 0)
    throw new Error(`SHA256SUMS lists no runtime archive for GOAT ${manifest.version}.`);
  const { platforms: _ignored, ...rest } = manifest;
  return { ...rest, platforms };
}

export type RuntimeManifestVerdict =
  | "compatible"
  | "update-required"
  | "client-too-old"
  | "missing-capability"
  | "invalid";

/**
 * Whether a client may start this runtime. `update-required`: the runtime is older than every
 * protocol the client speaks. `client-too-old`: the reverse.
 */
export function runtimeManifestVerdict(
  manifest: RuntimeManifest,
  client: RuntimeProtocolRanges = ownRuntimeProtocolRanges(ORCHESTRATION_PROTOCOL_VERSION),
  required: ReadonlyArray<string> = REQUIRED_RUNTIME_CAPABILITIES,
): RuntimeManifestVerdict {
  const protocol = compareRuntimeProtocols(client, { protocol: manifest.protocol });
  if (protocol === "unknown") return "invalid";
  if (protocol !== "compatible") return protocol;
  return required.every((capability) => manifest.capabilities.includes(capability))
    ? "compatible"
    : "missing-capability";
}

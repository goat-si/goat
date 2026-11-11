import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Bytes per chunk: one chunk stays well below what a relayed connection may queue. */
export const CHANNEL_BOT_ARTIFACT_CHUNK_BYTES = 512 * 1024;
/** Larger files answer `too_large` and are not sent. */
export const CHANNEL_BOT_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;

/** A file a GOAT Bot worker saved in its artifacts folder. */
export const ChannelBotArtifact = Schema.Struct({
  /** Inside the artifacts folder, with "/" separators. */
  relativePath: Schema.String,
  size: NonNegativeInt,
  modifiedAt: IsoDateTime,
});
export type ChannelBotArtifact = typeof ChannelBotArtifact.Type;

export const ChannelListBotArtifactsInput = Schema.Struct({});
export type ChannelListBotArtifactsInput = typeof ChannelListBotArtifactsInput.Type;

export const ChannelListBotArtifactsResult = Schema.Struct({
  /**
   * The server's artifacts folder as an absolute path, as the worker brief names it. Older
   * servers leave it out (see the `goatBotArtifactRoot` capability).
   */
  root: Schema.optionalKey(Schema.String),
  /** The newest files among those the walk visited, newest first. */
  artifacts: Schema.Array(ChannelBotArtifact),
  /** A bound on files, entries visited or depth stopped the walk. */
  truncated: Schema.Boolean,
});
export type ChannelListBotArtifactsResult = typeof ChannelListBotArtifactsResult.Type;

/**
 * Reads one chunk. Read a file one chunk at a time, passing the `version` of the first chunk
 * with every later `offset`; a missing or different version answers `changed`.
 */
export const ChannelReadBotArtifactInput = Schema.Struct({
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  offset: Schema.optionalKey(NonNegativeInt),
  version: Schema.optionalKey(Schema.String),
});
export type ChannelReadBotArtifactInput = typeof ChannelReadBotArtifactInput.Type;

export const ChannelReadBotArtifactResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("chunk"),
    relativePath: Schema.String,
    mimeType: Schema.String,
    size: NonNegativeInt,
    offset: NonNegativeInt,
    bytesBase64: Schema.String,
    version: Schema.String,
    done: Schema.Boolean,
  }),
  Schema.Struct({
    status: Schema.Literal("too_large"),
    relativePath: Schema.String,
    size: NonNegativeInt,
    maxBytes: NonNegativeInt,
  }),
  /** The file changed since the chunk that gave `version`; read it again from offset 0. */
  Schema.Struct({ status: Schema.Literal("changed"), relativePath: Schema.String }),
  /** Another read on this connection is still running; ask again when it finishes. */
  Schema.Struct({ status: Schema.Literal("busy"), relativePath: Schema.String }),
]);
export type ChannelReadBotArtifactResult = typeof ChannelReadBotArtifactResult.Type;

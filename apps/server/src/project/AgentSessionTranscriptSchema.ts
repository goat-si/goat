import { ClaudeSettings, CodexSettings } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { createTranscriptJsonSelector } from "./AgentSessionJson.ts";

export const TranscriptContentBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

export const TranscriptMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(TranscriptContentBlock)])),
  model: Schema.optional(Schema.String),
});

const CodexTurnMetadata = Schema.Struct({
  turn_id: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});

const TranscriptRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  // Pi entries form a tree through id/parentId; session_info entries carry its name.
  id: Schema.optional(Schema.String),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  aiTitle: Schema.optional(Schema.String),
  customTitle: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  isMeta: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  message: Schema.optional(TranscriptMessage),
  payload: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      session_id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
      history_base: Schema.optional(Schema.Unknown),
      content: Schema.optional(Schema.Array(TranscriptContentBlock)),
      internal_chat_message_metadata_passthrough: Schema.optional(Schema.Unknown),
    }),
  ),
});

export const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
export const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
export const decodeTranscriptRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(TranscriptRecord),
);
export const decodeTranscriptValue = Schema.decodeUnknownOption(TranscriptRecord);
export const decodePiEntryLinks = Schema.decodeUnknownOption(
  Schema.Struct({
    type: TranscriptRecord.fields.type,
    id: TranscriptRecord.fields.id,
    parentId: TranscriptRecord.fields.parentId,
  }),
);
export const selectTranscriptPath = createTranscriptJsonSelector(TranscriptRecord);
export const decodeCodexTurnMetadata = Schema.decodeUnknownOption(CodexTurnMetadata);
export type DecodedTranscriptRecord = typeof TranscriptRecord.Type;

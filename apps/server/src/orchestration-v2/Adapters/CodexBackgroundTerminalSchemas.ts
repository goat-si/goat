import * as Schema from "effect/Schema";

const CodexBackgroundTerminalTerminateResponse = Schema.Struct({
  terminated: Schema.Boolean,
});
const CodexBackgroundTerminalsListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      processId: Schema.String,
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
export type CodexBackgroundTerminalsListPage = typeof CodexBackgroundTerminalsListResponse.Type;
export const decodeCodexBackgroundTerminalTerminateResponse = Schema.decodeUnknownEffect(
  CodexBackgroundTerminalTerminateResponse,
);
export const decodeCodexBackgroundTerminalsListResponse = Schema.decodeUnknownEffect(
  CodexBackgroundTerminalsListResponse,
);

import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { OrchestrationV2TurnItemJson } from "./orchestrationV2.ts";

const legacyCommand = {
  id: "command-1",
  threadId: "thread-1",
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: null,
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-11-14T00:00:00.000Z",
  type: "command_execution",
  input: "sleep 180",
};
const decode = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const legacyReader = Schema.decodeUnknownSync(
  Schema.Struct({
    id: Schema.String,
    threadId: Schema.String,
    runId: Schema.NullOr(Schema.String),
    nodeId: Schema.NullOr(Schema.String),
    providerThreadId: Schema.NullOr(Schema.String),
    providerTurnId: Schema.NullOr(Schema.String),
    nativeItemRef: Schema.NullOr(Schema.Unknown),
    parentItemId: Schema.NullOr(Schema.String),
    ordinal: Schema.Number,
    status: Schema.String,
    title: Schema.NullOr(Schema.String),
    startedAt: Schema.NullOr(Schema.String),
    completedAt: Schema.NullOr(Schema.String),
    updatedAt: Schema.String,
    type: Schema.Literal("command_execution"),
    input: Schema.String,
  }),
);

it("accepts older commands and lets older readers ignore the new wake marker", () => {
  expect(decode(legacyCommand)).not.toHaveProperty("completionWake");
  expect(decode({ ...legacyCommand, completionWake: "always" })).toHaveProperty(
    "completionWake",
    "always",
  );
  expect(legacyReader({ ...legacyCommand, completionWake: "always" })).not.toHaveProperty(
    "completionWake",
  );
  expect(() => decode({ ...legacyCommand, completionWake: "invalid" })).toThrow();
});

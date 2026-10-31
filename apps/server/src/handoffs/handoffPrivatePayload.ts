/** What a handoff keeps outside the event log, as it is stored encrypted. */
import { AuthSessionId, HandoffHuman } from "@goat/contracts";
import * as Schema from "effect/Schema";

import { PROVIDER_CONTINUATION_PATHS } from "./providerContinuationPaths.ts";
import { SshProgressBinding } from "./sshProgressBinding.ts";

const ContinuationPayload = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("continuation"),
  human: HandoffHuman,
  args: Schema.Record(Schema.String, Schema.Unknown),
  approvedBySessionId: Schema.optional(AuthSessionId),
  sshProgress: Schema.optional(SshProgressBinding),
  namespace: Schema.optional(Schema.Literals(PROVIDER_CONTINUATION_PATHS)),
  /** What an approved provider change has done so far; its owning service decodes it. */
  progress: Schema.optional(Schema.Unknown),
});
const PrivatePayloadJson = Schema.fromJsonString(
  Schema.Union([
    ContinuationPayload,
    Schema.Struct({
      version: Schema.Literal(1),
      kind: Schema.Literal("progress_only"),
      sshProgress: SshProgressBinding,
      retainUntil: Schema.Number,
    }),
    // A finished provider change keeps what it did, apart from the arguments it ran with.
    Schema.Struct({
      version: Schema.Literal(1),
      kind: Schema.Literal("provider_outcome"),
      namespace: Schema.Literals(PROVIDER_CONTINUATION_PATHS),
      progress: Schema.Unknown,
      retainUntil: Schema.Number,
    }),
    // Legacy non-SSH payloads remain readable, but are never resumed as SSH work.
    Schema.Struct({
      version: Schema.optional(Schema.Literal(0)),
      kind: Schema.optional(Schema.Literal("legacy")),
      human: HandoffHuman,
      args: Schema.Record(Schema.String, Schema.Unknown),
    }),
    // A person ended this computer use grant after approving it; the sweep drops it with the rest.
    Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("computer_use_ended") }),
    Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("computer_use_consumed") }),
  ]),
);
export const encodePrivatePayload = Schema.encodeEffect(PrivatePayloadJson);
export const decodePrivatePayload = Schema.decodeUnknownEffect(PrivatePayloadJson);
export type PrivatePayload = typeof PrivatePayloadJson.Type;

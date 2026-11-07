/** Notices GOAT puts in a thread, and the kind unions that decode kinds this build does not know. */
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaGetter from "effect/SchemaGetter";

import {
  ForwardCompatibleOptional,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ChannelTaskChip } from "./channelLedger.ts";

function encodedKind(member: Schema.Top): string {
  const encoded = SchemaAST.toEncoded(member.ast);
  const kind = SchemaAST.isObjects(encoded)
    ? encoded.propertySignatures.find((property) => property.name === "kind")?.type
    : undefined;
  if (kind !== undefined && SchemaAST.isLiteral(kind) && typeof kind.literal === "string") {
    return kind.literal;
  }
  throw new Error("Each member of a kind union needs a literal string `kind`.");
}

export function kindUnionWithFallback<
  const Members extends ReadonlyArray<Schema.Top & { readonly Encoded: { readonly kind: string } }>,
  Unknown extends Schema.Top,
>(
  members: Members,
  unknown: (kind: Schema.optional<Schema.String>) => Unknown,
  fallback: (value: Unknown["Type"]) => Schema.Union<Members>["Encoded"],
) {
  const knownKinds: ReadonlySet<string> = new Set(members.map(encodedKind));
  const unknownKind = unknown(
    Schema.optional(
      Schema.String.check(
        Schema.makeFilter(
          (kind: string) => !knownKinds.has(kind) || "A known kind must decode in full.",
        ),
      ),
    ),
  ).pipe(
    Schema.decodeTo(Schema.Union(members), {
      decode: SchemaGetter.transform(fallback),
      encode: SchemaGetter.forbidden(() => "Unknown kinds are decode-only."),
    }),
  );
  return Schema.Union([...members, unknownKind]);
}

const SubagentNotificationSource = Schema.Struct({
  kind: Schema.Literal("subagent"),
  childThreadId: Schema.optional(ThreadId),
});
const CommandNotificationSource = Schema.Struct({ kind: Schema.Literal("command") });

/** Encode legacy background_command/background_task shapes first so older clients accept command/subagent sources. */
export const OrchestrationV2NotificationSource = kindUnionWithFallback(
  [
    Schema.Struct({
      kind: Schema.Literal("delegated_task"),
      taskIds: Schema.Array(NodeId),
      childThreadId: Schema.optional(ThreadId),
    }),
    Schema.Struct({
      kind: Schema.Literal("background_task"),
      work: Schema.Literal("subagent"),
      childThreadId: Schema.optional(ThreadId),
    }).pipe(
      Schema.decodeTo(Schema.toType(SubagentNotificationSource), {
        decode: SchemaGetter.transform(({ childThreadId }) =>
          childThreadId === undefined
            ? { kind: "subagent" as const }
            : { kind: "subagent" as const, childThreadId },
        ),
        encode: SchemaGetter.transform(({ childThreadId }) => ({
          kind: "background_task" as const,
          work: "subagent" as const,
          ...(childThreadId === undefined ? {} : { childThreadId }),
        })),
      }),
    ),
    Schema.Struct({ kind: Schema.Literal("background_command").transform("command") }),
    SubagentNotificationSource,
    CommandNotificationSource,
    Schema.Struct({ kind: Schema.Literal("monitor") }),
    Schema.Struct({
      kind: Schema.Literal("question"),
      threadId: ThreadId,
      requestId: RuntimeRequestId,
      humanRequired: Schema.Boolean,
    }),
    Schema.Struct({ kind: Schema.Literal("background_task") }),
    Schema.Struct({ kind: Schema.Literal("system") }),
  ],
  (kind) => Schema.Struct({ kind }),
  () => ({ kind: "background_task" }),
);
export type OrchestrationV2NotificationSource = typeof OrchestrationV2NotificationSource.Type;

export const OrchestrationV2Notification = Schema.Struct({
  source: OrchestrationV2NotificationSource,
  outcome: Schema.Literals(["completed", "failed", "cancelled", "updated", "unknown"]),
  summary: TrimmedNonEmptyString,
  detail: Schema.optional(Schema.String),
  /**
   * The channel ledger task this notification shows, for GOAT bot task chips. The status here
   * is the task's; the item status only says the record exists. A chip this build cannot read
   * decodes as absent, leaving the plain notification.
   */
  ledgerTask: ForwardCompatibleOptional(ChannelTaskChip),
  /** The run whose background work this notice reports, so its answer can go to that run's request. */
  aboutRunId: Schema.optional(RunId),
});
export type OrchestrationV2Notification = typeof OrchestrationV2Notification.Type;

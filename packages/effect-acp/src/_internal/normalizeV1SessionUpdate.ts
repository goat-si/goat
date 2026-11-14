import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "../compat.ts";
import type * as AcpSchemaV1 from "../_generated/schema-v1.gen.ts";

// ACP session notices postdate the pinned v1.21 and v2 alpha.3 schemas, so they arrive as unknown updates.
export const decodeNoticeUpdate = Schema.decodeUnknownOption(
  Schema.Struct({
    sessionUpdate: Schema.Literal("notice"),
    severity: Schema.String,
    title: Schema.NonEmptyString,
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
    _meta: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Json))),
  }),
);

export function normalizeV1SessionUpdate(
  notification: AcpSchemaV1.SessionNotification,
): AcpSchema.SessionNotification {
  // v1 passes unknown updates through raw, so a malformed notice must not reach consumers as one.
  if ((notification.update.sessionUpdate as string) === "notice") {
    const notice = decodeNoticeUpdate(notification.update);
    return {
      ...notification,
      update: Option.isSome(notice)
        ? notice.value
        : {
            sessionUpdate: "_t3_unknown",
            originalSessionUpdate: "notice",
            raw: notification.update,
          },
    };
  }
  const update = notification.update;
  // v1 defines a null tool name as unchanged; v2 consumers read null as a clear.
  if (
    (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
    update.name === null
  ) {
    const { name: _name, ...rest } = update;
    return { ...notification, update: rest } as unknown as AcpSchema.SessionNotification;
  }
  if (notification.update.sessionUpdate !== "available_commands_update") {
    return notification as unknown as AcpSchema.SessionNotification;
  }
  return {
    ...notification,
    update: {
      ...notification.update,
      availableCommands: notification.update.availableCommands.map((command) => {
        const { input, ...rest } = command;
        return {
          ...rest,
          ...(input == null ? {} : { input: { type: "text" as const, hint: input.hint } }),
        };
      }),
    },
  };
}

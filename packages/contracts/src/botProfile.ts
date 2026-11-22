import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const BotId = TrimmedNonEmptyString.pipe(Schema.brand("BotId"));
export type BotId = typeof BotId.Type;
export const MAIN_BOT_ID = "main";
export const BotRole = Schema.Literals(["main", "member"]);
/** A member bot's accent, as opaque sRGB `#RRGGBB`; clients pick the text color over it. */
export const BotColor = Schema.String.check(Schema.isPattern(/^#[0-9A-Fa-f]{6}$/));
export type BotColor = typeof BotColor.Type;
export const BOT_INSTRUCTIONS_MAX_BYTES = 16 * 1024;
export const BotInstructions = Schema.String.check(
  Schema.isMaxLength(BOT_INSTRUCTIONS_MAX_BYTES),
  Schema.makeFilter(
    (value) =>
      new TextEncoder().encode(value).byteLength <= BOT_INSTRUCTIONS_MAX_BYTES ||
      "Instructions must fit in 16 KB.",
  ),
);
const BotToolAllowlist = Schema.Union([
  Schema.Literal("all"),
  Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(256)),
]);
const BotTools = Schema.Struct({
  mcpServers: BotToolAllowlist,
  skills: BotToolAllowlist,
});
export const BotProfile = Schema.Struct({
  botId: BotId,
  role: BotRole,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  avatar: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(16))),
  purpose: Schema.String.check(Schema.isMaxLength(4000)),
  instructions: Schema.optionalKey(BotInstructions),
  tools: Schema.optionalKey(BotTools),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultProjectId: Schema.NullOr(ProjectId),
  environmentId: EnvironmentId,
  sessionThreadId: ThreadId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Setup the creating person can retry after a template bot already exists. */
  templateSetup: Schema.optionalKey(
    Schema.Struct({
      templateId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
      clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    }),
  ),
  /** Left out of the roster by a person; still answers. Absent means shown. */
  hidden: Schema.optionalKey(Schema.Boolean),
  /** A deleted member keeps its id and archived thread until it is restored. Absent means active. */
  state: Schema.optionalKey(Schema.Literals(["active", "deleted"])),
  /** A member's accent. Absent means the theme's neutral; the main bot has none. */
  color: Schema.optionalKey(BotColor),
});
export type BotProfile = typeof BotProfile.Type;

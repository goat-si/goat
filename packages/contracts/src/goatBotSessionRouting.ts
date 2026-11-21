import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GoatBotAlerts } from "./channelBotAttention.ts";
import { ModelSelection } from "./modelSelection.ts";

const routing = Schema.Literals(["session", "reception"]);
export const GoatBotSettingsFields = {
  goatBotAlerts: GoatBotAlerts.pipe(
    Schema.withDecodingDefault(Effect.succeed("needs_you" as const)),
  ),
  goatBotModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  goatBotSessionRouting: routing.pipe(
    Schema.withDecodingDefault(Effect.succeed("session" as const)),
  ),
};
export const GoatBotSettingsPatchFields = {
  goatBotAlerts: Schema.optionalKey(GoatBotAlerts),
  goatBotModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  goatBotSessionRouting: Schema.optionalKey(routing),
};

import * as Schema from "effect/Schema";
import { PositiveInt } from "./baseSchemas.ts";
import { ChannelDeliverableId } from "./channelDeliverables.ts";

export const ChannelDeliverableRetry = Schema.Struct({
  id: ChannelDeliverableId,
  attempt: PositiveInt,
});
export type ChannelDeliverableRetry = typeof ChannelDeliverableRetry.Type;

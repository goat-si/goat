import { ChannelTaskId } from "@goat/contracts";
import * as Schema from "effect/Schema";

const isChannelTaskId = Schema.is(ChannelTaskId);

export function validateBotTaskSearch(search: Record<string, unknown>): { task?: ChannelTaskId } {
  return isChannelTaskId(search.task) ? { task: search.task } : {};
}

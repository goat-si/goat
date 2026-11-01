import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ChannelLedger from "./ChannelLedger.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";

/**
 * Who an external account counts as now: its link, or else what its connection grants people
 * without one. Every check after intake reads this, so unlinking, narrowing a link, or switching
 * a connection to linked accounts only takes effect for work that is still waiting.
 */
export const currentChannelIdentity = Effect.fn("channel.currentIdentity")(function* (input: {
  readonly connectionId: string;
  readonly externalActorId: string;
}) {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const linked = yield* ledger.findIdentity(input);
  if (linked !== undefined) return linked;
  const slack = yield* SlackChannelSettings.SlackChannelSettings;
  return Option.getOrUndefined(
    yield* slack.unlinkedIdentity(input.connectionId, input.externalActorId),
  );
});

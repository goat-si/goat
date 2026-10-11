/**
 * SlackChannelSettings - the port behind the `slackChannel.*` RPCs.
 *
 * Tokens go in through `configure` and are kept in the server secret store; nothing here
 * returns them. Until a live Slack runtime is assembled, the server provides an implementation
 * that fails with `adapter_unavailable` and advertises `slackChannel: false`.
 *
 * @module SlackChannelSettings
 */
import type {
  SlackChannelConfigureInput,
  SlackChannelDisconnectInput,
  SlackChannelSettingsError,
  SlackChannelSettings as SlackChannelSettingsSnapshot,
  SlackChannelStatusEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export class SlackChannelSettings extends Context.Service<
  SlackChannelSettings,
  {
    readonly get: () => Effect.Effect<
      ReadonlyArray<SlackChannelSettingsSnapshot>,
      SlackChannelSettingsError
    >;
    readonly configure: (
      input: SlackChannelConfigureInput,
    ) => Effect.Effect<SlackChannelSettingsSnapshot, SlackChannelSettingsError>;
    readonly disconnect: (
      input: SlackChannelDisconnectInput,
    ) => Effect.Effect<void, SlackChannelSettingsError>;
    readonly streamStatus: () => Stream.Stream<SlackChannelStatusEvent, SlackChannelSettingsError>;
  }
>()("t3/channels/SlackChannelSettings") {}

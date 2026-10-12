/**
 * SlackChannelSettings - the port behind the `slackChannel.*` RPCs.
 *
 * Tokens go in through `configure` and are kept in the server secret store; nothing here
 * returns them. The server assembles the live implementation from `slack/` (see ChannelLayers);
 * `layerUnavailable` serves tests that fake Slack.
 *
 * @module SlackChannelSettings
 */
import type {
  SlackChannelDefaultTarget,
  SlackChannelConfigureInput,
  SlackChannelDisconnectInput,
  SlackChannelSettingsError,
  SlackChannelSettings as SlackChannelSettingsSnapshot,
  SlackChannelStatusEvent,
} from "@t3tools/contracts";
import { SlackChannelSettingsError as SettingsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ChannelConnectionOwner } from "./ChannelIngressContext.ts";

export class SlackChannelSettings extends Context.Service<
  SlackChannelSettings,
  {
    readonly get: () => Effect.Effect<
      ReadonlyArray<SlackChannelSettingsSnapshot>,
      SlackChannelSettingsError
    >;
    /** `clearCredentials: true` closes the connection and deletes both tokens. */
    /** `owner` is the authenticated host owner the connection will act for. */
    readonly configure: (
      input: SlackChannelConfigureInput,
      owner: ChannelConnectionOwner,
    ) => Effect.Effect<SlackChannelSettingsSnapshot, SlackChannelSettingsError>;
    /** Closes the connection and sets `enabled: false`. Stored tokens stay. */
    readonly disconnect: (
      input: SlackChannelDisconnectInput,
    ) => Effect.Effect<void, SlackChannelSettingsError>;
    /** Emits the current status of every connection once, then only changes. */
    readonly streamStatus: () => Stream.Stream<SlackChannelStatusEvent, SlackChannelSettingsError>;
    /** Defaults for work started from a connection; none for an unknown connection. */
    readonly defaultTarget: (
      connectionId: string,
    ) => Effect.Effect<Option.Option<SlackChannelDefaultTarget>, SlackChannelSettingsError>;
  }
>()("t3/channels/SlackChannelSettings") {}

/**
 * Slack switched off: every call says Slack is unavailable, and no default target exists. It
 * never pretends to store a token.
 */
export const layerUnavailable = Layer.succeed(
  SlackChannelSettings,
  SlackChannelSettings.of({
    get: () => Effect.fail(new SettingsError({ reason: "adapter_unavailable" })),
    configure: () => Effect.fail(new SettingsError({ reason: "adapter_unavailable" })),
    disconnect: () => Effect.fail(new SettingsError({ reason: "adapter_unavailable" })),
    streamStatus: () => Stream.fail(new SettingsError({ reason: "adapter_unavailable" })),
    defaultTarget: () => Effect.succeed(Option.none()),
  }),
);

import { assert, describe, it } from "@effect/vitest";
import { SlackChannelConnectionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import { owner } from "./testkit/ChannelHarness.ts";

describe("SlackChannelSettings unavailable adapter", () => {
  it.effect.each(["get", "configure", "disconnect", "streamStatus"] as const)(
    "fails %s with adapter_unavailable",
    (operation) =>
      Effect.gen(function* () {
        const settings = yield* SlackChannelSettings.SlackChannelSettings;
        const error = yield* Effect.flip(
          operation === "get"
            ? settings.get()
            : operation === "configure"
              ? settings.configure(
                  {
                    connectionId: SlackChannelConnectionId.make("slack-1"),
                    enabled: true,
                    appToken: "test-app-token",
                    botToken: "test-bot-token",
                  },
                  owner,
                )
              : operation === "disconnect"
                ? settings.disconnect({ connectionId: SlackChannelConnectionId.make("slack-1") })
                : Stream.runCollect(settings.streamStatus()),
        );
        assert.strictEqual(error._tag, "SlackChannelSettingsError");
        assert.strictEqual(error.reason, "adapter_unavailable");
      }).pipe(Effect.provide(SlackChannelSettings.layerUnavailable)),
  );
});

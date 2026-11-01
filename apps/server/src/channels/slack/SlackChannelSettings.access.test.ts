import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SlackChannelRuntime from "./SlackChannelRuntime.ts";
import * as SlackChannelSettingsLive from "./SlackChannelSettings.live.ts";
import { owner } from "./slackChannelTestSupport.ts";
import { makeFakeSlackSdk } from "./slackSdkFake.ts";

const APP_TOKEN = "xapp-1-access-app";
const BOT_TOKEN = "xoxb-access-bot";

/** The settings service over a runtime that only records what it is asked to run. */
const withSettings = <A, E>(
  baseDir: string,
  body: (
    settings: Effect.Success<typeof SlackChannelSettingsLive.make>,
    applied: ReadonlyArray<SlackChannelRuntime.SlackRuntimeConnection>,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig>,
) => {
  const applied: Array<SlackChannelRuntime.SlackRuntimeConnection> = [];
  const runtime = Layer.mock(SlackChannelRuntime.SlackChannelRuntime)({
    apply: (connection) => Effect.sync(() => void applied.push(connection)),
    isCurrent: () => Effect.succeed(true),
    status: () => Effect.succeed({ status: "disabled" }),
    streamStatus: Stream.empty,
  });
  return Effect.scoped(
    Effect.flatMap(SlackChannelSettingsLive.make, (settings) => body(settings, applied)).pipe(
      Effect.provide(
        Layer.mergeAll(
          runtime,
          makeFakeSlackSdk().layer,
          ServerSecretStore.layer,
          ServerSettings.layerTest(),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:slack-access")),
          }),
        ).pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
};

const tempBaseDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "goat-slack-access-test-" });
}).pipe(Effect.provide(NodeServices.layer));

/** Writes a settings file in the format saved before channel scope and user access existed. */
const writeLegacyFile = (allowedChannelIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(config.stateDir, "slack-channel-settings.json"),
      JSON.stringify({
        version: 1,
        connections: [
          {
            connectionId: "slack-0123456789ab",
            enabled: false,
            teamId: "T0TEAM",
            botUserId: "U0BOT",
            allowedChannelIds,
            owner,
          },
        ],
      }),
    );
  });

describe("Slack connection access", () => {
  it.effect("reads files saved before access settings existed with the new defaults", () =>
    Effect.gen(function* () {
      for (const [allowed, scope] of [
        [[], "all"],
        [["C0ALLOWED"], "listed"],
      ] as const) {
        const baseDir = yield* tempBaseDir;
        yield* withSettings(baseDir, () => writeLegacyFile(allowed));
        yield* withSettings(baseDir, (settings) =>
          Effect.gen(function* () {
            const [connection] = yield* settings.get();
            assert.equal(connection?.channelScope, scope);
            assert.equal(connection?.userAccess, "workspace");
            assert.equal(connection?.unlinkedRuntimeModeCeiling, "approval-required");
            const guest = yield* settings.unlinkedIdentity("slack-0123456789ab", "U0GUEST");
            assert.deepEqual(Option.getOrUndefined(guest), {
              ownerId: owner.ownerId,
              principalId: "unlinked:slack-0123456789ab:U0GUEST",
              displayName: "Slack U0GUEST",
              runtimeModeCeiling: "approval-required",
              grantedScopes: ["orchestration:operate"],
            });
          }),
        );
      }
    }),
  );

  it.effect("passes the scope and the unlinked ceiling to the running connection", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      yield* withSettings(baseDir, (settings, applied) =>
        Effect.gen(function* () {
          const created = yield* settings.configure(
            { enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN },
            owner,
          );
          assert.equal(created.channelScope, "all");
          assert.equal(applied.at(-1)?.channelScope, "all");
          assert.equal(applied.at(-1)?.unlinkedRuntimeModeCeiling, "approval-required");

          const narrowed = yield* settings.configure({
            connectionId: created.connectionId,
            enabled: true,
            channelScope: "listed",
            allowedChannelIds: ["C0ALLOWED"],
            userAccess: "linked",
          });
          assert.equal(narrowed.channelScope, "listed");
          assert.equal(narrowed.userAccess, "linked");
          assert.equal(applied.at(-1)?.channelScope, "listed");
          assert.equal(applied.at(-1)?.unlinkedRuntimeModeCeiling, undefined);
          assert.isTrue(
            Option.isNone(yield* settings.unlinkedIdentity(created.connectionId, "U0GUEST")),
          );

          // Choosing "every channel" keeps the list for switching back.
          const widened = yield* settings.configure({
            connectionId: created.connectionId,
            enabled: true,
            channelScope: "all",
          });
          assert.equal(widened.channelScope, "all");
          assert.deepEqual(widened.allowedChannelIds, ["C0ALLOWED"]);
        }),
      );
    }),
  );

  it.effect("rejects a channel list scope with no channels", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      yield* withSettings(baseDir, (settings) =>
        Effect.gen(function* () {
          const error = yield* settings
            .configure(
              {
                enabled: true,
                appToken: APP_TOKEN,
                botToken: BOT_TOKEN,
                channelScope: "listed",
                allowedChannelIds: [],
              },
              owner,
            )
            .pipe(Effect.flip);
          assert.equal(error.reason, "invalid_input");
        }),
      );
    }),
  );

  it.effect("sets the scope from the list when an older client sends only the list", () =>
    Effect.gen(function* () {
      const baseDir = yield* tempBaseDir;
      yield* withSettings(baseDir, (settings) =>
        Effect.gen(function* () {
          const created = yield* settings.configure(
            { enabled: true, appToken: APP_TOKEN, botToken: BOT_TOKEN },
            owner,
          );
          const listed = yield* settings.configure({
            connectionId: created.connectionId,
            enabled: true,
            allowedChannelIds: ["C0ALLOWED"],
          });
          assert.equal(listed.channelScope, "listed");
          const cleared = yield* settings.configure({
            connectionId: created.connectionId,
            enabled: true,
            allowedChannelIds: [],
          });
          assert.equal(cleared.channelScope, "all");
        }),
      );
    }),
  );
});

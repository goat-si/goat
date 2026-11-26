import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as SqlClient from "effect/sql/SqlClient";
import * as Secrets from "./auth/ServerSecretStore.ts";
import * as Config from "./config.ts";
import { readConversationMemoryEnabled } from "./memory/conversationMemoryPolicy.ts";
import * as Persistence from "./persistence/Sqlite.ts";
import * as Settings from "./serverSettings.ts";

const dependencies = Layer.mergeAll(
  Persistence.layerMemory,
  Config.layerTest(process.cwd(), { prefix: "goat-memory-pause-" }),
).pipe(Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)));

const settingsLayer = Settings.layer.pipe(Layer.provide(Secrets.layer));

it.effect.each(["missing", "legacy"] as const)(
  "a paused environment stays paused across a restart with a %s settings file",
  (replacement) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const config = yield* Config.ServerConfig;
      yield* Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        expect((yield* settings.getSettings).conversationMemoryEnabled).toBe(true);
        yield* settings.updateSettings({ conversationMemoryEnabled: false });
        expect(yield* readConversationMemoryEnabled(sql)).toBe(false);
      }).pipe(Effect.provide(Layer.fresh(settingsLayer)));
      if (replacement === "missing") yield* fs.remove(config.settingsPath);
      else yield* fs.writeFileString(config.settingsPath, "{}");
      yield* Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        expect((yield* settings.getSettings).conversationMemoryEnabled).toBe(false);
        const policy = yield* Settings.MemoryProviderCommittedPolicy;
        expect((yield* policy.read).enableAgentMemoryAccess).toBe(false);
        yield* settings.updateSettings({ conversationMemoryEnabled: true });
        expect(yield* readConversationMemoryEnabled(sql)).toBe(true);
      }).pipe(Effect.provide(Layer.fresh(settingsLayer)));
    }).pipe(Effect.provide(dependencies)),
);

it.effect("a failed settings rename rolls back the conversation memory transition", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    let denyRename = false;
    yield* Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.updateSettings({ conversationMemoryEnabled: false });
      denyRename = true;
      const result = yield* Effect.result(
        settings.updateSettings({ conversationMemoryEnabled: true }),
      );
      expect(result._tag).toBe("Failure");
      expect(yield* readConversationMemoryEnabled(sql)).toBe(false);
      const policy = yield* Settings.MemoryProviderCommittedPolicy;
      expect((yield* policy.read).enableAgentMemoryAccess).toBe(false);
    }).pipe(
      Effect.provide(Layer.fresh(settingsLayer)),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        rename: (from, to) =>
          denyRename
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                }),
              )
            : fs.rename(from, to),
      }),
    );
  }).pipe(Effect.provide(dependencies)),
);

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as HostProcess from "@goat/shared/HostProcess";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const sha256 = Effect.fn("test.sha256")(function* (value: string) {
  const digest = yield* Digest.Digest;
  return Hex.encode(
    yield* digest.digest(Digest.sha256, new TextEncoder().encode(value)).pipe(Effect.orDie),
  );
});

const makeCaptureLogger = (logs: CapturedLog[]) =>
  Logger.make(({ fiber, message }) => {
    logs.push({
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });

const findIdentityLog = (
  logs: ReadonlyArray<CapturedLog>,
  source: Identify.TelemetryIdentitySource,
  errorTag: string,
) => logs.find((log) => log.annotations.source === source && log.annotations.errorTag === errorTag);

const layerIdentity = (prefix: string, logs?: CapturedLog[]) =>
  Layer.provideMerge(
    ServerSecretStore.layer,
    ServerConfig.layerTest(process.cwd(), { prefix }),
  ).pipe(
    Layer.merge(
      logs === undefined
        ? Layer.empty
        : Logger.layer([makeCaptureLogger(logs)], { mergeWithExisting: false }),
    ),
  );

const writeHomeFile = Effect.fn("test.writeHomeFile")(function* (
  homeDirectory: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(homeDirectory, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
  return filePath;
});

/** Codex and Claude logins as their CLIs store them; identity must never read these. */
const writeProviderLogins = Effect.fn("test.writeProviderLogins")(function* (
  homeDirectory: string,
) {
  yield* writeHomeFile(
    homeDirectory,
    ".codex/auth.json",
    JSON.stringify({
      tokens: {
        account_id: "team-workspace",
        id_token: [
          "e30",
          Buffer.from(
            JSON.stringify({ "https://api.openai.com/auth": { user_id: "user-openai-person" } }),
          ).toString("base64url"),
          "sig",
        ].join("."),
      },
    }),
  );
  yield* writeHomeFile(
    homeDirectory,
    ".claude.json",
    JSON.stringify({ userID: "claude-machine", oauthAccount: { accountUuid: "claude-person" } }),
  );
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("telemetry identity", (it) => {
  it.effect(
    "derives the identity only from the install's random id, never from provider logins",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDirectory = path.join(config.baseDir, "home");
        yield* writeProviderLogins(homeDirectory);
        const anonymousId = "persisted-anonymous-id";
        yield* fileSystem.writeFileString(config.anonymousIdPath, anonymousId);
        const installId = yield* sha256(anonymousId);

        const identity = yield* Identify.getTelemetryIdentity.pipe(
          Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
        );

        assert.deepEqual(identity, { distinctId: installId, installId });
      }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-install-"))),
  );

  it.effect("reports only the GOAT Connect account as a server owner", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const path = yield* Path.Path;
      const homeDirectory = path.join(config.baseDir, "home");
      yield* secrets.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("user_connect"));
      yield* writeProviderLogins(homeDirectory);

      const owners = yield* Identify.getServerOwners.pipe(
        Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
      );

      assert.deepEqual(owners, [{ source: "connect", ownerId: yield* sha256("user_connect") }]);
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-owners-"))),
  );

  it.effect("resetting the identity gives the install a new id", () =>
    Effect.gen(function* () {
      const before = yield* Identify.getTelemetryIdentity;
      yield* Identify.resetTelemetryIdentity;
      const after = yield* Identify.getTelemetryIdentity;

      assert.isNotNull(before.installId);
      assert.isNotNull(after.installId);
      assert.notEqual(after.installId, before.installId);
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-reset-"))),
  );

  it.effect("leaves no torn anonymous id behind when its write fails midway", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const tornWrites = FileSystem.FileSystem.of({
        ...fileSystem,
        open: (filePath, options) =>
          fileSystem.open(filePath, options).pipe(
            Effect.map((file): FileSystem.File =>
              Object.assign(Object.create(file), {
                writeAll: (buffer: Uint8Array) =>
                  file.writeAll(buffer.subarray(0, Math.floor(buffer.length / 2))).pipe(
                    Effect.andThen(
                      Effect.fail(
                        PlatformError.systemError({
                          _tag: "WriteZero",
                          module: "FileSystem",
                          method: "writeAll",
                          pathOrDescriptor: filePath,
                        }),
                      ),
                    ),
                  ),
              }),
            ),
          ),
      });

      const identity = yield* Identify.getTelemetryIdentity.pipe(
        Effect.provideService(FileSystem.FileSystem, tornWrites),
      );

      assert.deepEqual(identity, { distinctId: null, installId: null });
      assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-torn-"))),
  );

  it.effect("does not overwrite the anonymous id path after a non-NotFound read failure", () => {
    const logs: CapturedLog[] = [];

    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(config.anonymousIdPath);

      const identity = yield* Identify.getTelemetryIdentity;
      assert.deepEqual(identity, { distinctId: null, installId: null });
      assert.deepEqual(yield* fileSystem.readDirectory(config.anonymousIdPath), []);

      const readLog = findIdentityLog(logs, "anonymous", "TelemetryIdentityReadError");
      assert.equal(readLog?.annotations.filePath, config.anonymousIdPath);
      assert.notEqual(readLog?.annotations.platformReason, "NotFound");
      assert.notProperty(readLog?.annotations ?? {}, "cause");
      assert.isUndefined(
        findIdentityLog(logs, "anonymous", "TelemetryAnonymousIdPersistenceError"),
      );
    }).pipe(Effect.provide(layerIdentity("t3-telemetry-identify-read-", logs)));
  });
});

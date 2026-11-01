import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import {
  ARCHIVE,
  arch,
  isRemoteLaunch,
  makeRunningProcess,
  makeSuccessfulProcess,
  makeUploadFixture,
  platform,
  testHttpClient,
  testNetService,
  uploadTarget,
} from "./tunnel.fixture.ts";
import { SshEnvironmentManager } from "./tunnel.ts";

/** Real manager and archive acquisition, with only process/HTTP/network boundaries replaced. */
export const makeEnsureFlightFixture = Effect.gen(function* () {
  const archive = yield* makeUploadFixture();
  const uploadEntered = yield* Deferred.make<void>();
  const releaseUpload = yield* Deferred.make<void>();
  const pairingEntered = yield* Deferred.make<void>();
  const releasePairing = yield* Deferred.make<void>();
  const count = { acquisitions: 0, uploads: 0, launches: 0, pairings: 0, forwards: 0, kills: 0 };
  const state = {
    forwardAlive: true,
    pairingFails: false,
    launchFails: false,
    holdPairing: false,
    holdUpload: true,
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected command");
      if (command.args.includes("-G"))
        return makeSuccessfulProcess(
          `hostname ${uploadTarget.hostname}\nuser ${uploadTarget.username}\nport ${uploadTarget.port}\n`,
        );
      if (command.args.includes("-N")) {
        count.forwards++;
        state.forwardAlive = true;
        return {
          ...makeRunningProcess(() => count.kills++),
          isRunning: Effect.sync(() => state.forwardAlive),
        };
      }
      if (command.args.includes("goat-runtime-cleanup")) return makeSuccessfulProcess("");
      const stdin = command.options.stdin;
      const script =
        stdin !== undefined &&
        typeof stdin === "object" &&
        "stream" in stdin &&
        Stream.isStream(stdin.stream)
          ? yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString)
          : "";
      const answer = Stream.make(
        new TextEncoder().encode(
          `Authenticated to ${uploadTarget.hostname} ([192.0.2.1]:22) using "publickey".\n`,
        ),
      );
      if (command.args.includes("-c")) {
        count.uploads++;
        return {
          ...makeSuccessfulProcess(""),
          stderr: answer,
          exitCode: Deferred.succeed(uploadEntered, undefined).pipe(
            Effect.andThen(state.holdUpload ? Deferred.await(releaseUpload) : Effect.void),
            Effect.as(ChildProcessSpawner.ExitCode(0)),
          ),
        };
      }
      if (script.includes("auth pairing create")) {
        count.pairings++;
        yield* Deferred.succeed(pairingEntered, undefined);
        if (state.holdPairing) yield* Deferred.await(releasePairing);
        return state.pairingFails
          ? {
              ...makeSuccessfulProcess(""),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            }
          : makeSuccessfulProcess(
              JSON.stringify({ credential: `fixture-pairing-${count.pairings}` }),
            );
      }
      if (isRemoteLaunch(command.args)) {
        count.launches++;
        if (state.launchFails)
          return {
            ...makeSuccessfulProcess(""),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          };
        return {
          ...makeSuccessfulProcess(
            JSON.stringify({
              status: "ready",
              selectedVersion: ARCHIVE.archiveVersion,
              remotePort: 3773,
              serverKind: "managed",
            }),
          ),
          stderr: answer,
        };
      }
      return {
        ...makeSuccessfulProcess(JSON.stringify({ platform, arch, ready: count.uploads > 0 })),
        stderr: answer,
      };
    }),
  );
  const fs: FileSystem.FileSystem = {
    ...archive.fs,
    readFile: (path) => {
      if (path.startsWith(archive.directory) && path.endsWith(".tar.gz")) count.acquisitions++;
      return archive.fs.readFile(path);
    },
  };
  const runner = {
    ...ARCHIVE,
    archiveDirectory: archive.directory,
    refreshOwnedRuntimeOnFirstConnection: true,
    publishedFallback: false,
  };
  const layer = Layer.mergeAll(
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: archive.root })),
    Layer.succeed(FileSystem.FileSystem, fs),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(NetService.NetService, testNetService),
    Layer.succeed(HttpClient.HttpClient, testHttpClient),
    SshAuth.SshPasswordPrompt.disabledLayer,
    SshEnvironmentManager.layer({
      resolveCliRunner: Effect.sync(() => ({ ...runner })),
      leaveRemoteServerRunning: true,
    }),
  );
  return {
    layer,
    runner,
    count,
    state,
    uploadEntered,
    releaseUpload,
    pairingEntered,
    releasePairing,
    root: archive.root,
  };
});

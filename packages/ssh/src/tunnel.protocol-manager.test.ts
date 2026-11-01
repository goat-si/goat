import { SSH_RUNTIME_PROTOCOL_VERSION } from "@goat/shared/sshRuntimeProtocol";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { assert, describe, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import * as SshTunnel from "./tunnel.ts";
import {
  testHttpClient,
  testNetService,
  ARCHIVE,
  uploadTarget,
  installArchivePsDouble,
  makeSuccessfulProcess,
} from "./tunnel.fixture.ts";
import { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "SSH runtime protocol selection",
  () => {
    const prepareScenario = (mode: "busy" | "unknown" | "idle" | "failure" | "pairing") =>
      Effect.gen(function* () {
        const f = yield* makeProtocolFixture({
          live: true,
          kind: "managed",
          oldVersion: "1.2.2",
          drain: true,
          ssh: SSH_RUNTIME_PROTOCOL_VERSION,
          orchestration: ORCHESTRATION_PROTOCOL_VERSION,
        });
        const before = yield* f.snapshot;
        yield* f.fs.writeFileString(
          `${f.test}/activity`,
          mode === "busy" || mode === "pairing" ? "busy" : mode === "unknown" ? "unknown" : "idle",
        );
        if (mode === "pairing") yield* f.fs.writeFileString(`${f.test}/pairing-fail`, "fail");
        let failUpload = mode === "failure";
        const transport = ChildProcessSpawner.make((command) => {
          if (failUpload && command._tag === "StandardCommand" && command.args.includes("-c")) {
            failUpload = false;
            return Effect.succeed({
              ...makeSuccessfulProcess("remote upload failed"),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            });
          }
          return f.transport.spawn(command);
        });
        const context = yield* Layer.buildWithScope(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transport),
            Layer.succeed(FileSystem.FileSystem, f.observedFs),
            Layer.succeed(HttpClient.HttpClient, testHttpClient),
            Layer.succeed(NetService.NetService, testNetService),
            SshAuth.SshPasswordPrompt.disabledLayer,
            SshTunnel.SshEnvironmentManager.layer({
              resolveCliRunner: Effect.succeed({
                ...f.runner,
                refreshOwnedRuntimeOnFirstConnection: true,
              }),
              leaveRemoteServerRunning: true,
            }),
          ),
          yield* Scope.Scope,
        );
        const manager = Context.get(context, SshTunnel.SshEnvironmentManager);
        yield* Effect.gen(function* () {
          if (mode === "pairing") {
            assert.isTrue(
              Result.isFailure(
                yield* Effect.result(
                  manager.ensureEnvironment(uploadTarget, { issuePairingToken: true }),
                ),
              ),
            );
            assert.deepEqual(yield* f.snapshot, before);
            yield* Effect.sync(() => process.kill(f.pid, 0));
            assert.equal(yield* f.fs.readFileString(`${f.test}/activity-requests`), "1");
          } else {
            if (mode === "failure") {
              // Missing/unusable archives now permit compatible fallback; upload
              // failures must still fail and preserve the first-connection retry.
              const failed = yield* Effect.result(manager.ensureEnvironment(uploadTarget));
              assert.isTrue(Result.isFailure(failed));
              if (Result.isFailure(failed))
                assert.include(failed.failure.message, "Uploading the runtime archive failed");
              assert.deepEqual(yield* f.snapshot, before);
            }
            yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true });
          }
        }).pipe(Effect.provide(context));
        return { f, before, manager, context };
      });
    class PreparedScenario extends Context.Service<
      PreparedScenario,
      Effect.Success<ReturnType<typeof prepareScenario>>
    >()("@goat/ssh/tunnel.protocol-manager.test/PreparedScenario") {}
    // Cold installation and first pairing establish the scenario; subsequent decisions
    // get their own normal test budget while setup retains the normal hook budget.
    const scenario = (mode: Parameters<typeof prepareScenario>[0]) =>
      layer(
        Layer.effect(PreparedScenario, prepareScenario(mode)).pipe(
          Layer.provide(NodeServices.layer),
        ),
        { excludeTestServices: true },
      );
    for (const mode of ["busy", "unknown", "idle", "failure"] as const) {
      scenario(mode)(`first connection: ${mode}`, (it) => {
        it.effect(
          `manager consumes settled startup decisions and retries pending ones: ${mode}`,
          () =>
            Effect.gen(function* () {
              const { f, manager, context } = yield* PreparedScenario;
              yield* Effect.gen(function* () {
                if (mode === "idle" || mode === "failure") {
                  yield* installArchivePsDouble(
                    f.home,
                    Number((yield* f.fs.readFileString(`${f.state}/pid`)).trim()),
                    Number((yield* f.fs.readFileString(`${f.state}/port`)).trim()),
                    ARCHIVE.archiveVersion,
                  );
                }
                const count = yield* f.fs.readFileString(`${f.test}/activity-requests`);
                // Unknown activity returns 404, so each probe also tries the legacy endpoint.
                assert.equal(count, mode === "busy" ? "1" : "2");
                yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
                yield* manager.disconnectEnvironment(uploadTarget);
                yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true });
                assert.equal(
                  yield* f.fs.readFileString(`${f.test}/activity-requests`),
                  mode === "unknown" ? "4" : mode === "busy" ? "3" : count,
                );
                const events = (yield* f.fs.readFileString(`${f.test}/events`))
                  .trim()
                  .split("\n")
                  .map((line) => JSON.parse(line));
                assert.equal(events.filter((event) => event.type === "self-stop").length, 1);
                assert.equal(events.filter((event) => event.type === "drain").length, 1);
                assert.equal(
                  events.filter(
                    (event) => event.type === "supervise" && event.status === "replaced",
                  ).length,
                  1,
                );
                assert.isFalse(events.some((event) => event.type === "stop"));
              }).pipe(Effect.provide(context));
            }),
        );
      });
    }
    scenario("pairing")("failed first pairing", (it) => {
      it.effect("pairing recovery reuses the deferred attachment until an explicit refresh", () =>
        Effect.gen(function* () {
          const { f, before, manager, context } = yield* PreparedScenario;
          yield* Effect.gen(function* () {
            yield* f.fs.remove(`${f.test}/pairing-fail`);
            yield* f.fs.writeFileString(`${f.test}/activity`, "idle");
            const paired = yield* manager.ensureEnvironment(uploadTarget, {
              issuePairingToken: true,
            });
            assert.notProperty(paired, "type");
            if ("type" in paired) throw new Error("Expected the retained attachment");
            assert.equal(paired.pairingToken, "1.2.2");
            assert.equal(paired.pendingReplacement?.reason, "busy");
            assert.equal(yield* f.fs.readFileString(`${f.test}/activity-requests`), "1");
            assert.deepEqual(yield* f.snapshot, before);
            const beforeRefresh = yield* f.fs.readFileString(`${f.test}/events`);
            for (const type of ["self-stop", "drain", "stop"])
              assert.notInclude(beforeRefresh, `"type":"${type}"`);
            yield* manager.ensureEnvironment(uploadTarget, {
              issuePairingToken: true,
              refreshRuntime: true,
            });
            assert.equal(yield* f.fs.readFileString(`${f.test}/activity-requests`), "3");
            assert.notEqual((yield* f.snapshot).pid, before.pid);
            assert.include(
              (yield* f.snapshot).identity!,
              `/versions/${ARCHIVE.archiveVersion}/goat serve`,
            );
            yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true });
            assert.equal(yield* f.fs.readFileString(`${f.test}/activity-requests`), "3");
            const events = yield* f.fs.readFileString(`${f.test}/events`);
            assert.equal(events.split('"type":"self-stop"').length - 1, 1);
          }).pipe(Effect.provide(context));
        }),
      );
    });
  },
);

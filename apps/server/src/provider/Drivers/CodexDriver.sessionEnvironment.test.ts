import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as CodexAdapter from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import { CODEX_TEST_RUNTIME_POLICY } from "../../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import {
  codexReplayPreamble,
  makeCodexReplayTranscript,
} from "../../orchestration-v2/Adapters/CodexReplay.testkit.ts";
import { CodexDriver } from "./CodexDriver.ts";
import { layerTest } from "./CodexDriver.testkit.ts";

it.layer(layerTest)("Codex session environment", (it) => {
  it.effect(
    "a running session retains its opening environment while a new session reads the host",
    () =>
      Effect.gen(function* () {
        const host: NodeJS.ProcessEnv = { HOME: "/fixture", CODEX_HOME: "/fixture/a" };
        const launches: Array<NodeJS.ProcessEnv> = [];
        const instanceId = ProviderInstanceId.make("environment-test");
        const threadId = ThreadId.make("environment-thread");
        const modelSelection = { instanceId, model: "gpt-test" };
        const transcript = makeCodexReplayTranscript({
          scenario: "session-environment",
          entries: codexReplayPreamble({
            nativeThreadId: "native-a",
            nativeTurnId: "unused",
            prompt: "",
          }).slice(0, 5),
        });
        const instance = yield* CodexDriver.create({
          instanceId,
          displayName: "Environment test",
          enabled: true,
          environment: [{ name: "TEST_VAR", value: "1", sensitive: false }],
          config: CodexDriver.defaultConfig(),
        }).pipe(
          Effect.provide(
            Layer.mock(CodexInstallation.CodexInstallation)({
              managedDirectory: "unused",
              compatibility: () => Effect.sync(() => undefined),
            }),
          ),
          Effect.provideService(HostProcess.Environment, host),
          Effect.provideService(HostProcess.HomeDirectory, "/fixture"),
          Effect.provideService(CodexAdapter.CodexAppServerClientFactory, {
            open: (input) =>
              Effect.gen(function* () {
                launches.push(input.environment);
                const driver = yield* CodexReplay.makeReplayDriver(transcript);
                const context = yield* Layer.build(CodexReplay.layerReplayWithDriver(driver));
                return Context.get(context, CodexClient.CodexAppServerClient);
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterOpenSessionError({
                      driver: CodexAdapter.CODEX_DRIVER_KIND,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              ),
          }),
        );
        const open = (name: string) =>
          instance.orchestrationAdapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(name),
            modelSelection,
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          });
        const first = yield* open("first");
        host.CODEX_HOME = "/fixture/b";
        yield* open("second");
        yield* first.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });
        expect(launches.map((env) => [env.CODEX_HOME, env.TEST_VAR])).toEqual([
          ["/fixture/a", "1"],
          ["/fixture/b", "1"],
        ]);
      }).pipe(Effect.scoped),
  );
});

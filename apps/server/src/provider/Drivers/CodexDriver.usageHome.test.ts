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

/** Opens a session and reports `usedPercent` before thread/start answers, so ensureThread waits for it. */
const usageTranscript = (name: string, usedPercent: number) => {
  const preamble = codexReplayPreamble({
    nativeThreadId: `native-${name}`,
    nativeTurnId: "unused",
    prompt: "",
  }).slice(0, 5);
  return makeCodexReplayTranscript({
    scenario: `usage-home-${name}`,
    entries: [
      ...preamble.slice(0, 4),
      {
        type: "emit_inbound" as const,
        label: "account/rateLimits/updated",
        frame: {
          method: "account/rateLimits/updated",
          params: {
            rateLimits: {
              limitId: "codex",
              primary: { usedPercent, resetsAt: 2000100000, windowDurationMins: 300 },
            },
          },
        },
      },
      ...preamble.slice(4),
    ],
  });
};

it.layer(layerTest)("Codex usage and the session's home", (it) => {
  it.effect(
    "usage from a session opened under an earlier home does not replace the current home's usage",
    () =>
      Effect.gen(function* () {
        const host: NodeJS.ProcessEnv = { HOME: "/fixture", CODEX_HOME: "/fixture/a" };
        const instanceId = ProviderInstanceId.make("usage-home");
        const threadId = ThreadId.make("usage-home-thread");
        const modelSelection = { instanceId, model: "gpt-test" };
        const transcripts: Record<string, ReturnType<typeof usageTranscript>> = {
          a: usageTranscript("a", 10),
          b: usageTranscript("b", 50),
        };
        const instance = yield* CodexDriver.create({
          instanceId,
          displayName: "Usage home test",
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
                const transcript = transcripts[input.providerSessionId];
                if (transcript === undefined) return yield* Effect.die("unknown session");
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
        const ensure = (session: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
          session.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          });
        const percents = Effect.map(instance.snapshot.getSnapshot, (snapshot) =>
          (snapshot.usageLimits?.windows ?? []).map((window) => window.usedPercent),
        );
        const underA = yield* open("a");
        host.CODEX_HOME = "/fixture/b";
        const underB = yield* open("b");
        yield* ensure(underA);
        expect(yield* percents).not.toContain(10);
        yield* ensure(underB);
        expect(yield* percents).toContain(50);
      }).pipe(Effect.scoped),
  );
});

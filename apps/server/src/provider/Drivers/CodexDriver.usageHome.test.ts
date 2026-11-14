import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as CodexAdapter from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CodexInstallation from "../CodexInstallation.ts";
import { CodexDetachedAppServers } from "../CodexDetachedAppServerLive.ts";
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

/**
 * An instance with an unrelated variable whose sessions replay `usage` by session name. The factory
 * always starts a fresh process; `preservedRecord` lists a kept record as if one had exited.
 */
const usageHarness = (input: {
  readonly host: NodeJS.ProcessEnv;
  readonly usage: Readonly<Record<string, number>>;
  readonly homeDirectory?: string;
  readonly preservedRecord?: boolean;
}) =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("usage-home");
    const threadId = ThreadId.make("usage-home-thread");
    const modelSelection = { instanceId, model: "gpt-test" };
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
      (effect) =>
        input.preservedRecord === true
          ? Effect.provide(
              effect,
              Layer.mock(CodexDetachedAppServers)({
                socketTransportEnabled: false,
                listPreservedForSession: () => Effect.succeed(["codex-exited"]),
                keptStartedAt: () => Effect.sync(() => undefined),
              }),
            )
          : effect,
      Effect.provideService(HostProcess.Environment, input.host),
      Effect.provideService(HostProcess.HomeDirectory, input.homeDirectory ?? "/fixture"),
      Effect.provideService(CodexAdapter.CodexAppServerClientFactory, {
        open: (open) =>
          Effect.gen(function* () {
            const usedPercent = input.usage[open.providerSessionId];
            if (usedPercent === undefined) return yield* Effect.die("unknown session");
            const transcript = usageTranscript(open.providerSessionId, usedPercent);
            const driver = yield* CodexReplay.makeReplayDriver(transcript);
            const context = yield* Layer.build(CodexReplay.layerReplayWithDriver(driver));
            return Context.get(context, CodexClient.CodexAppServerClient);
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: CodexAdapter.CODEX_DRIVER_KIND,
                  providerSessionId: open.providerSessionId,
                  cause,
                }),
            ),
          ),
      }),
    );
    /** Opens a session; the returned effect lets it report its usage. */
    const open = (name: string, cwd?: string) => {
      const runtimePolicy =
        cwd === undefined ? CODEX_TEST_RUNTIME_POLICY : { ...CODEX_TEST_RUNTIME_POLICY, cwd };
      return instance.orchestrationAdapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(name),
          modelSelection,
          runtimePolicy,
        })
        .pipe(
          Effect.map((session) =>
            session.ensureThread({ threadId, modelSelection, runtimePolicy }),
          ),
        );
    };
    const percents = Effect.map(instance.snapshot.getSnapshot, (snapshot) =>
      (snapshot.usageLimits?.windows ?? []).map((window) => window.usedPercent),
    );
    /** A status check that commits under the host's current home. */
    const check = instance.snapshot.refresh.pipe(Effect.asVoid);
    return { open, percents, check };
  });

it.layer(layerTest)("Codex usage and the session's home", (it) => {
  it.effect("usage counts only for the home of the last committed check", () =>
    Effect.gen(function* () {
      const host: NodeJS.ProcessEnv = { HOME: "/fixture", CODEX_HOME: "/fixture/a" };
      const { open, percents, check } = yield* usageHarness({
        host,
        usage: { a: 10, b: 50, b2: 60 },
      });
      yield* check;
      const reportA = yield* open("a");
      host.CODEX_HOME = "/fixture/b";
      const reportB = yield* open("b");
      yield* reportB;
      expect(yield* percents).not.toContain(50);
      yield* check;
      yield* reportA;
      expect(yield* percents).not.toContain(10);
      yield* yield* open("b2");
      expect(yield* percents).toContain(60);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a relative CODEX_HOME in another workspace is another account than the one checks use",
    () =>
      Effect.gen(function* () {
        const host: NodeJS.ProcessEnv = { HOME: "/fixture", CODEX_HOME: "account" };
        const { open, percents, check } = yield* usageHarness({ host, usage: { elsewhere: 10 } });
        yield* check;
        yield* yield* open("elsewhere", "/fixture/workspace");
        expect(yield* percents).not.toContain(10);
      }).pipe(Effect.scoped),
  );

  // The fixture uses a symlink.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "a session opened through a link to the checked home reports into it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(`${root}/home`);
        yield* fs.symlink(`${root}/home`, `${root}/alias`);
        const host: NodeJS.ProcessEnv = { HOME: root, CODEX_HOME: `${root}/home` };
        const { open, percents, check } = yield* usageHarness({
          host,
          usage: { linked: 30 },
          homeDirectory: root,
        });
        yield* check;
        host.CODEX_HOME = `${root}/alias`;
        const report = yield* open("linked");
        host.CODEX_HOME = `${root}/home`;
        yield* report;
        expect(yield* percents).toContain(30);
      }).pipe(Effect.scoped),
  );

  it.effect("a usage report reads no environment", () =>
    Effect.gen(function* () {
      let reads = 0;
      const host = new Proxy<NodeJS.ProcessEnv>(
        { HOME: "/fixture", CODEX_HOME: "/fixture/a" },
        {
          ownKeys: (target) => {
            reads += 1;
            return Reflect.ownKeys(target);
          },
        },
      );
      const { open, percents, check } = yield* usageHarness({ host, usage: { a: 10 } });
      yield* check;
      const report = yield* open("a");
      const before = reads;
      yield* report;
      expect(yield* percents).toContain(10);
      expect(reads).toBe(before);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a fresh process started after an exited kept record reports its home like any other",
    () =>
      Effect.gen(function* () {
        const host: NodeJS.ProcessEnv = { HOME: "/fixture", CODEX_HOME: "/fixture/a" };
        const { open, percents, check } = yield* usageHarness({
          host,
          usage: { fresh: 10 },
          preservedRecord: true,
        });
        yield* check;
        const report = yield* open("fresh");
        host.CODEX_HOME = "/fixture/b";
        yield* check;
        yield* report;
        expect(yield* percents).not.toContain(10);
      }).pipe(Effect.scoped),
  );
});

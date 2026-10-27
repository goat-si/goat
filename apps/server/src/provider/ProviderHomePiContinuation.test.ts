import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceEnvironment,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import { PiAdapterV2Driver } from "@goat/provider-pi/server";
import { PiSettings } from "@goat/provider-pi/settings";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as HostProcess from "@goat/shared/HostProcess";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Config from "../config.ts";
import { fleetSnapshot } from "../hub/parity.testkit.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as Runner from "../processRunner.ts";
import { prepareProviderHomeRuntime } from "./ProviderHomeRuntime.ts";

const instanceId = ProviderInstanceId.make("pi-home");
const threadId = ThreadId.make("thread-pi-home");
const HOME = "http://127.0.0.1:10100/v1";
const decodePi = Schema.decodeUnknownSync(PiSettings);
const decodeLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});
const modelSelection = { instanceId, model: "default" };

/**
 * Pi at its RPC boundary. A process starts a new session file in its session directory, and
 * switch_session succeeds only for a file some process saved in the directory this one uses.
 */
const fakePi = () => {
  const saved = new Set<string>();
  const spawns: Array<NodeJS.ProcessEnv> = [];
  const switched: Array<string> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const env = ChildProcess.isStandardCommand(command) ? (command.options.env ?? {}) : {};
      spawns.push(env);
      const sessionDir = env.PI_CODING_AGENT_SESSION_DIR ?? "";
      let sessionFile = `${sessionDir}/session-${spawns.length}.jsonl`;
      saved.add(sessionFile);
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      let buffer = "";
      const respond = (record: Record<string, unknown>) => {
        const base = {
          type: "response",
          id: record.id,
          command: String(record.type),
          success: true,
        };
        switch (record.type) {
          case "get_state":
            return {
              ...base,
              data: {
                thinkingLevel: "high",
                isStreaming: false,
                isCompacting: false,
                sessionFile,
                sessionId: "00000000-0000-4000-8000-000000000001",
                messageCount: 0,
                pendingMessageCount: 0,
              },
            };
          case "switch_session": {
            const target = String(record.sessionPath);
            switched.push(target);
            if (!saved.has(target) || !target.startsWith(`${sessionDir}/`))
              return { ...base, success: false, error: "Session file not found" };
            sessionFile = target;
            return { ...base, data: { cancelled: false } };
          }
          case "get_available_models":
            return { ...base, data: { models: [] } };
          case "get_entries":
            return { ...base, data: { entries: [], leafId: null } };
          case "get_messages":
            return { ...base, data: { messages: [] } };
          default:
            return base;
        }
      };
      const onStdin = (chunk: Uint8Array) =>
        Effect.gen(function* () {
          buffer += new TextDecoder().decode(chunk);
          for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.length === 0) continue;
            const record = decodeLine(line);
            if (typeof record.id !== "string") continue;
            yield* Queue.offer(
              stdout,
              new TextEncoder().encode(`${encodeLine(respond(record))}\n`),
            );
          }
        });
      return ChildProcessSpawner.makeHandle({
        // Outside the valid pid range, so a group kill can never land.
        pid: ChildProcessSpawner.ProcessId(999_999_997),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach(onStdin),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, spawns, switched };
};

/** This machine's OpenCodex: its Pi export lists the Home models current at each read. */
const layerHome = (models: () => ReadonlyArray<string>) =>
  Layer.mergeAll(
    Layer.mock(Inventory.OpenCodexInventory)({
      readParity: Effect.succeed({
        ...fleetSnapshot("mac-studio"),
        binaries: [{ path: "/fixture/ocx", version: "2.92.0" }],
      }),
    }),
    Layer.mock(Runner.ProcessRunner)({
      run: () =>
        Effect.sync(() => ({
          stdout: JSON.stringify({
            providers: {
              opencodex: {
                baseUrl: HOME,
                api: "openai-completions",
                models: models().map((id) => ({ id })),
              },
            },
          }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        })),
    }),
    Config.layerTest(process.cwd(), { prefix: "provider-home-pi-" }),
    IdAllocator.layer,
    McpProviderSessions.layer,
    TestProviderHost.layer(),
  ).pipe(Layer.provideMerge(NodeServices.layer));

it.effect(
  "resumes a routed Pi session from its saved path after the instance is re-created",
  () => {
    let models: ReadonlyArray<string> = ["provider/a"];
    const pi = fakePi();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const user = yield* fs.makeTempDirectoryScoped({ prefix: "pi-user-agent-" });
      const userAgent = [{ name: "PI_CODING_AGENT_DIR", value: user, sensitive: false }];
      const prepare = prepareProviderHomeRuntime(
        "pi",
        instanceId,
        { modelRoute: "opencodex", opencodexBaseUrl: HOME },
        userAgent,
      ).pipe(Effect.provideService(HostProcess.Environment, {}));
      /** One instance lifetime: create the adapter, open a session and register the thread. */
      const register = (
        environment: ProviderInstanceEnvironment,
        existing: OrchestrationV2ProviderThread | undefined,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* PiAdapterV2Driver.create({
              instanceId,
              displayName: undefined,
              enabled: true,
              environment,
              config: decodePi({}),
            });
            const runtime = yield* adapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make("provider-session-pi-home"),
              modelSelection,
              runtimePolicy,
            });
            return yield* runtime.ensureThread({
              threadId,
              modelSelection,
              runtimePolicy,
              ...(existing === undefined ? {} : { existingProviderThread: existing }),
            });
          }),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
            offer: () => Effect.void,
            take: Effect.never,
          }),
        );

      const first = yield* prepare;
      const created = yield* register(first.environment, undefined);
      const savedPath = created.nativeThreadRef?.nativeId;
      assert.equal(savedPath, path.join(user, "sessions", "session-1.jsonl"));
      // Home's catalog changes and the instance is re-created from a newly published agent directory.
      models = ["provider/b"];
      const second = yield* prepare;
      const resumed = yield* register(second.environment, created);
      assert.equal(resumed.nativeThreadRef?.nativeId, savedPath);
      assert.deepEqual(pi.switched, [savedPath]);
      const [firstLaunch, secondLaunch] = pi.spawns;
      assert.notEqual(firstLaunch?.PI_CODING_AGENT_DIR, secondLaunch?.PI_CODING_AGENT_DIR);
      assert.equal(secondLaunch?.PI_CODING_AGENT_SESSION_DIR, path.join(user, "sessions"));
    }).pipe(Effect.provide(layerHome(() => models)), Effect.scoped);
  },
);

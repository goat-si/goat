import { ProviderSessionId, ThreadId } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { assert, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import packageJson from "../../../package.json" with { type: "json" };
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import * as CodexAdapterV2Testkit from "./CodexAdapterV2.testkit.ts";

const modelSelection = { instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID, model: "gpt-5.4" };
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
});
// Every thread on an instance shares this session, as IdAllocator assigns it.
const providerSessionId = ProviderSessionId.make("provider-session-app-server-respawn");

/** One app-server process: handshake, one thread/start, then an optional held stop. */
const appServerProcess = (input: {
  readonly nativeThreadId: string;
  readonly stopsAfterThreadStart: boolean;
}): CodexReplay.CodexAppServerReplayTranscript => ({
  provider: "codex",
  protocol: "codex.app-server",
  version: "0.144.0",
  scenario: `app-server-respawn-${input.nativeThreadId}`,
  entries: [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "T3 Code", title: "T3 Code", version: packageJson.version },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "T3 Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "linux",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: 2,
        method: "thread/start",
        params: { config: CodexAdapterV2.CODEX_THREAD_CONFIG },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
            cwd: "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    ...(input.stopsAfterThreadStart
      ? ([
          // The client ignores this unknown notification; the test holds it to choose
          // when the process stops, like `ocx sync --restart-codex` on an idle host.
          { type: "emit_inbound", label: "external-stop", frame: { method: "test/externalStop" } },
          { type: "runtime_exit", status: "success" },
        ] satisfies ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>)
      : []),
  ],
});

it.effect(
  "spawns a fresh app-server for the next thread after the held one exits outside GOAT",
  () =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<void>();
      const firstProcessReleased = yield* Deferred.make<void>();
      const processes = [
        appServerProcess({ nativeThreadId: "respawn-first", stopsAfterThreadStart: true }),
        appServerProcess({ nativeThreadId: "respawn-second", stopsAfterThreadStart: false }),
      ];
      let spawns = 0;
      const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
        open: (openInput) =>
          Effect.gen(function* () {
            const transcript = processes[spawns++];
            if (transcript === undefined) return yield* Effect.die("unexpected app-server spawn");
            if (spawns === 1)
              yield* Effect.addFinalizer(() => Deferred.succeed(firstProcessReleased, undefined));
            const driver = yield* CodexReplay.makeReplayDriver(transcript, {
              beforeEmitInbound: (entry) =>
                entry.label === "external-stop" ? Deferred.await(stop) : Effect.void,
            });
            const context = yield* Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                    providerSessionId: openInput.providerSessionId,
                    cause,
                  }),
              ),
            );
            return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.provide(context),
            );
          }),
      };

      yield* Effect.gen(function* () {
        const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const ensureThread = (threadId: ThreadId) =>
          manager
            .open({ threadId, providerSessionId, modelSelection, runtimePolicy })
            .pipe(
              Effect.flatMap((runtime) =>
                runtime.ensureThread({ threadId, modelSelection, runtimePolicy }),
              ),
            );

        const first = yield* ensureThread(ThreadId.make("thread-app-server-respawn-first"));
        assert.equal(first.nativeThreadRef?.nativeId, "respawn-first");

        yield* Deferred.succeed(stop, undefined);
        // The manager releases the dead session, which closes the first process's scope.
        yield* Deferred.await(firstProcessReleased);

        const second = yield* ensureThread(ThreadId.make("thread-app-server-respawn-second"));
        assert.equal(second.nativeThreadRef?.nativeId, "respawn-second");
        assert.equal(spawns, 2);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "codex-app-server-respawn" },
            CodexAdapterV2Testkit.layerWithClientFactory({
              scenario: "codex-app-server-respawn",
              clientFactory,
            }),
            { runEffectWorker: false },
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

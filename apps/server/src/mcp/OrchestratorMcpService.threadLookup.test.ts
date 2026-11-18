import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { layerOrchestratorService } from "./OrchestratorMcpService.testkit.ts";

describe("OrchestratorMcpService thread lookup", () => {
  const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
  const launched = liveThreadShell(ThreadId.make(`mcp:${bareId}`));
  const deletedLaunched = { ...launched, deletedAt: DateTime.makeUnsafe("2026-10-05T00:00:00Z") };
  const client: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:thread-lookup"),
    requestNamespace: "client:thread-lookup",
    thread: undefined,
    client: { sessionId: "thread-lookup", label: "Claude Code", access: "full-access" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const service = (
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
    sent: Ref.Ref<number>,
    overrides: Partial<ThreadManagementService.ThreadManagementService["Service"]> = {},
  ) =>
    layerOrchestratorService.pipe(
      Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
      Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed(shells.find((shell) => shell.id === threadId) ?? null),
            sendToThread: () => Ref.update(sent, (count) => count + 1).pipe(Effect.as({} as never)),
            ...overrides,
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ),
      ),
    );
  const failuresFor = (shells: ReadonlyArray<OrchestrationV2ThreadShell>) =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const read = yield* mcp.readThread(client, { threadId: bareId }).pipe(Effect.flip);
        const send = yield* mcp
          .sendToThread(client, { threadId: bareId, message: "hello" })
          .pipe(Effect.flip);
        const wait = yield* mcp.waitForThread(client, { threadId: bareId }).pipe(Effect.flip);
        return { read, send, wait, sends: yield* Ref.get(sent) };
      }).pipe(Effect.provide(service(shells, sent)));
    });

  it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
    Effect.gen(function* () {
      const { read, send, wait, sends } = yield* failuresFor([launched]);
      for (const error of [read, send, wait]) {
        assert.equal(error.code, "thread_not_found");
        assert.include(error.message, `mcp:${bareId}`);
      }
      assert.equal(sends, 0);
    }),
  );

  it.effect("keeps the plain message for an id that matches nothing", () =>
    Effect.gen(function* () {
      const { read, send, wait } = yield* failuresFor([]);
      assert.equal(read.code, "thread_not_found");
      assert.equal(read.message, `Thread ${bareId} is no longer available.`);
      assert.equal(send.code, "thread_not_found");
      assert.equal(send.message, `Thread ${bareId} was not found.`);
      assert.equal(wait.code, "thread_not_found");
      assert.equal(wait.message, send.message);
    }),
  );

  it.effect("does not name an mcp: thread that was deleted", () =>
    Effect.gen(function* () {
      const { read, send, wait } = yield* failuresFor([deletedLaunched]);
      assert.equal(read.message, `Thread ${bareId} is no longer available.`);
      assert.equal(send.message, `Thread ${bareId} was not found.`);
      assert.equal(wait.message, send.message);
    }),
  );

  it.effect("refuses waiting without orchestration capability before reading the target", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* mcp
          .waitForThread({ ...client, capabilities: new Set() }, { threadId: bareId })
          .pipe(Effect.flip);
        assert.equal(error.code, "capability_denied");
      }).pipe(
        Effect.provide(
          service([], sent, {
            getThreadShell: () => Effect.die("Unauthorized target access"),
          }),
        ),
      );
    }),
  );

  it.effect("waits on the caller's own thread without a separate shell lookup", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* mcp.waitForThread(
          {
            ...client,
            thread: {
              threadId: launched.id,
              providerSessionId: "provider-session:wait-self",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
          },
          { threadId: launched.id },
        );
        assert.deepEqual(result, {
          threadId: launched.id,
          runId: null,
          status: "idle",
          timedOut: false,
        });
      }).pipe(
        Effect.provide(
          service([], sent, {
            getThreadShell: () => Effect.die("Unexpected shell lookup for the caller"),
            getThreadRecords: () => Effect.succeed(idleThreadProjection(launched)),
            waitForThread: () =>
              Effect.succeed({ threadId: launched.id, run: null, timedOut: false }),
          }),
        ),
      );
    }),
  );
  it.effect("waits on another thread without loading its history", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* mcp.waitForThread(client, { threadId: launched.id });
        assert.equal(result.status, "idle");
      }).pipe(
        Effect.provide(
          service([launched], sent, {
            getProjectThreadRecords: (input, sections) => {
              assert.equal(input.projectId, launched.projectId);
              assert.deepEqual(sections, []);
              return Effect.succeed(idleThreadProjection(launched));
            },
            waitForThread: () =>
              Effect.succeed({ threadId: launched.id, run: null, timedOut: false }),
          }),
        ),
      );
    }),
  );
});

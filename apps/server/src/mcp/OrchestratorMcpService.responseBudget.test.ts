import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  type OrchestratorMcpThreadReadResult,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vite-plus/test";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(layerNoFleetSync),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);
const environmentId = EnvironmentId.make("environment-mcp-orchestrator-detail");
const projectId = ProjectId.make("project-mcp-orchestrator-detail");
const parentThreadId = ThreadId.make("thread-mcp-orchestrator-parent");
const activeRunId = RunId.make("run-mcp-active");
const now = DateTime.makeUnsafe("2026-08-04T12:00:00.000Z");
const parentInstanceId = ProviderInstanceId.make("codex");
const makeScope = (): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-mcp-orchestrator-detail",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session-mcp-orchestrator-detail",
    providerInstanceId: parentInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});
function baseThread(input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}) {
  return {
    id: input.threadId,
    projectId,
    title: input.title,
    createdBy: "user" as const,
    creationSource: "mcp" as const,
    modelSelection: {
      instanceId: input.instanceId,
      model: input.model,
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    archivedAt: null,
    deletedAt: null,
    providerInstanceId: input.instanceId,
    createdAt: now,
    updatedAt: now,
  };
}
function makeRun(input: {
  readonly id: RunId;
  readonly ordinal: number;
  readonly status: "running" | "waiting" | "cancelled" | "queued" | "completed";
  readonly instanceId?: ProviderInstanceId;
}) {
  return {
    id: input.id,
    ordinal: input.ordinal,
    status: input.status,
    modelSelection: {
      instanceId: input.instanceId ?? parentInstanceId,
      model: "gpt-5.4",
    },
    providerInstanceId: input.instanceId ?? parentInstanceId,
    requestedAt: now,
    startedAt: input.status === "cancelled" || input.status === "queued" ? null : now,
    completedAt: input.status === "cancelled" || input.status === "completed" ? now : null,
  };
}

/** The service over one projection whose timeline pages come from `getTimelinePage`. */
function threadReadLayer(
  projection: OrchestrationV2ThreadProjection,
  getTimelinePage: ThreadManagementService.ThreadManagementService["Service"]["getTimelinePage"],
) {
  return layerOrchestratorService.pipe(
    Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
    Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getTimelinePage,
          getThreadRecords: () => Effect.succeed(projection),
          getProjectThreadRecords: () => Effect.succeed(projection),
          getThreadShell: () =>
            Effect.succeed(projection.thread as unknown as OrchestrationV2ThreadShell),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([]),
        } satisfies Partial<ProviderRegistry.ProviderRegistry["Service"]>),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );
}

it("readThread returns the newest items that fit the response budget", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [makeRun({ id: activeRunId, ordinal: 1, status: "running" })],
    visibleTurnItems: [],
    turnItems: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  // A long thread's newest 100 activity items, the read agents make most.
  const rows = Array.from({ length: 100 }, (_, position) => ({
    position,
    visibility: "local",
    sourceThreadId: parentThreadId,
    sourceItemId: TurnItemId.make(`turn-item-mcp-long-${position}`),
    item: {
      type: "reasoning",
      runId: activeRunId,
      status: "completed",
      title: null,
      text: "x".repeat(1_500),
      updatedAt: now,
    },
  }));
  const pageOptions: Array<unknown> = [];

  const layer = threadReadLayer(projection, (_threadId, options) => {
    pageOptions.push(options);
    return Effect.succeed({
      items: rows as unknown as OrchestrationV2ThreadProjection["visibleTurnItems"],
      totalItems: 3_000,
      hasMore: false,
      hasEarlier: true,
    });
  });

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const read = {
      threadId: parentThreadId,
      view: "activity" as const,
      limit: 100,
      maxCharsPerItem: 1_500,
    };
    const result = yield* service.readThread(makeScope(), read);
    // Linked environments and the CLI read as clients without a cursor and follow only hasMore.
    const first = yield* service.readThread({ ...makeScope(), thread: undefined }, read);
    const fromStart = yield* service.readThread(makeScope(), { ...read, afterPosition: -1 });

    expect(pageOptions).toEqual([
      { beforePosition: Number.POSITIVE_INFINITY, limit: 100, view: "activity" },
      { limit: 100, view: "activity" },
      { afterPosition: -1, limit: 100, view: "activity" },
    ]);
    // Claude Code saves results over ~50k chars of this JSON to a file instead of showing them.
    expect(JSON.stringify(result).length).toBeLessThan(31_000);
    expect(result.items.length).toBeLessThan(100);
    expect(result.items.at(-1)?.position).toBe(99);
    expect(result.earlierPosition).toBe(result.items[0]?.position);
    expect(result.hasMore).toBe(false);
    expect(first.items[0]?.position).toBe(0);
    expect(first.hasMore).toBe(true);
    expect(first.nextPosition).toBe(first.items.at(-1)?.position);
    expect(fromStart.items[0]?.position).toBe(0);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

it("readThread keeps an activity page within an MCP client's output limit and pages the rest", async () => {
  const projection = {
    thread: baseThread({
      threadId: parentThreadId,
      title: "Parent",
      instanceId: parentInstanceId,
      model: "gpt-5.4",
    }),
    runs: [makeRun({ id: activeRunId, ordinal: 1, status: "running" })],
    visibleTurnItems: [],
    turnItems: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    contextTransfers: [],
    subagents: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  const rows = Array.from({ length: 60 }, (_, position) => ({
    position,
    visibility: "visible",
    sourceThreadId: parentThreadId,
    sourceItemId: TurnItemId.make(`turn-item-mcp-reasoning-${position}`),
    item: {
      type: "reasoning",
      runId: activeRunId,
      status: "completed",
      // Command titles can carry a whole command.
      title: position === 1 ? "標".repeat(60_000) : null,
      text: position === 0 ? "😀a".repeat(30_000) : `${position} `.padEnd(3_000, "x"),
      updatedAt: now,
    },
  }));
  const layer = threadReadLayer(projection, (_threadId, options) => {
    const after =
      options.itemId === undefined
        ? rows.filter((row) => row.position > (options.afterPosition ?? -1))
        : rows.filter((row) => row.sourceItemId === options.itemId);
    return Effect.succeed({
      items: after.slice(
        0,
        options.limit,
      ) as unknown as OrchestrationV2ThreadProjection["visibleTurnItems"],
      totalItems: rows.length,
      hasMore: after.length > options.limit,
      hasEarlier: false,
    });
  });

  await Effect.gen(function* () {
    const service = yield* OrchestratorMcpService.OrchestratorMcpService;
    const positions: Array<number> = [];
    let afterPosition: number | undefined;
    for (let page = 0; page < rows.length; page++) {
      const result = yield* service.readThread(makeScope(), {
        threadId: parentThreadId,
        view: "activity",
        limit: 100,
        maxCharsPerItem: 1_500,
        afterPosition: afterPosition ?? -1,
      });
      // Claude Code rejects MCP results over 25k tokens; CJK text is about a token per char.
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(50_000);
      if (page === 0) expect(result.hasMore).toBe(true);
      positions.push(...result.items.map((item) => item.position));
      if (!result.hasMore) break;
      afterPosition = result.nextPosition ?? undefined;
    }
    expect(positions).toEqual(rows.map((row) => row.position));

    const longText = rows[0]?.item.text ?? "";
    const pages: Array<string> = [];
    let textOffset: number | null = 0;
    while (textOffset !== null) {
      const result: OrchestratorMcpThreadReadResult = yield* service.readThread(makeScope(), {
        threadId: parentThreadId,
        view: "activity",
        itemId: rows[0]?.sourceItemId,
        textOffset,
        maxCharsPerItem: 50_000,
      });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(50_000);
      const text = result.items[0]?.text ?? "";
      expect(text.isWellFormed()).toBe(true);
      pages.push(text);
      textOffset = result.items[0]?.nextTextOffset ?? null;
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join("")).toBe(longText);

    (projection.thread as { title: string }).title = "標".repeat(30_000);
    const underHugeTitle = yield* service.readThread(makeScope(), {
      threadId: parentThreadId,
      view: "activity",
      itemId: rows[0]?.sourceItemId,
      maxCharsPerItem: 50_000,
    });
    expect(underHugeTitle.items[0]?.text?.length).toBeGreaterThan(1_000);
  }).pipe(Effect.provide(layer), Effect.runPromise);
});

/** Shared fixture for ChannelChildWork tests: a seeded channel task, its admission, and a scripted thread service. */
import {
  ChannelDispatchTarget,
  ChannelInboundMessage,
  ChannelRequester,
  ChannelTask,
  ChannelTaskEvent,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ChannelChildWork from "../ChannelChildWork.ts";
import * as ChannelChildWorkStore from "../channelChildWorkStore.ts";
import * as ChannelLedger from "../ChannelLedger.ts";
import {
  bindingIdFor,
  contentHashFor,
  conversationIdFor,
  inputIdFor,
  taskEventIdFor,
  taskIdFor,
} from "../channelIds.ts";
import { prepareTransition, type ChannelTaskEventSpec } from "../channelTaskWrites.ts";

export const NOW = "2026-10-12T00:00:00.000Z";
const workerThread = ThreadId.make("worker-1");
export const childThread = ThreadId.make("child-1");

const decodeMessage = Schema.decodeUnknownSync(ChannelInboundMessage);
const decodeRequester = Schema.decodeUnknownSync(ChannelRequester);
const decodeTask = Schema.decodeUnknownSync(ChannelTask);
const decodeEvent = Schema.decodeUnknownSync(ChannelTaskEvent);
const decodeTarget = Schema.decodeUnknownSync(ChannelDispatchTarget);
export const isChildWorkError = Schema.is(ChannelChildWork.ChannelChildWorkError);

const slackMessage = decodeMessage({
  kind: "slack",
  connectionId: "slack-1",
  conversationKey: "T1:C1:1760000000.000100",
  externalMessageId: "1760000000.000200",
  idempotencyKey: "T1:Ev1",
  actor: { externalActorId: "U1" },
  replyAddress: {
    kind: "slack",
    connectionId: "slack-1",
    teamId: "T1",
    channelId: "C1",
    rootTs: "1760000000.000100",
  },
  text: "Audit the release.",
  attachments: [],
  receivedAt: NOW,
  intent: "message",
});

const requester = decodeRequester({
  ownerId: "owner",
  principalId: "owner",
  displayName: "Jun",
  originKind: "slack",
  externalActorId: "U1",
  runtimeModeCeiling: "approval-required",
  grantedScopes: ["orchestration:read", "orchestration:operate"],
});

const target = decodeTarget({
  environmentId: "env-1",
  projectId: "project-1",
  modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
});

/** A run record as reconcileLocal reads it: ordinal for recency, status for the state map. */
export const fakeRun = (status: string, ordinal = 1) => ({ id: "run-1", status, ordinal });

const unused = () => Effect.die("Unexpected test dependency call");

export interface DispatchedStop {
  readonly commandId: string;
  readonly threadId: string;
  readonly stopDelegatedTasks: boolean | undefined;
}

/** How getThreadRecords answers: a failure per thread, and a hook that runs during the read. */
export interface RecordReads {
  readonly failures: Map<string, unknown>;
  during?: () => Effect.Effect<void>;
}

export const missingThread = { _tag: "ProjectionStoreThreadNotFoundError" };

const threadsLayer = (
  runs: ReadonlyMap<string, ReadonlyArray<unknown>>,
  failures: ReadonlyMap<string, unknown> = new Map(),
  dispatched: Array<DispatchedStop> = [],
  providerThreads: ReadonlyMap<string, ReadonlyArray<unknown>> = new Map(),
  reads: RecordReads = { failures: new Map() },
) =>
  Layer.succeed(
    ThreadManagementService.ThreadManagementService,
    ThreadManagementService.ThreadManagementService.of({
      listOlderSettledThreads: unused,
      awaitBackgroundTasks: unused,
      getLaunchedPendingQuestions: unused,
      assertReviewTaskSendAllowed: unused,
      listActiveSubagentThreadIds: unused,
      getThreadShell: unused,
      getShellSnapshot: unused,
      readShellSnapshot: unused,
      ensureLegacyTranscript: unused,
      dispatch: ((command: {
        readonly type: string;
        readonly commandId: string;
        readonly threadId?: string;
        readonly stopDelegatedTasks?: boolean;
      }) => {
        if (command.threadId === undefined) return Effect.die("unexpected non-thread command");
        dispatched.push({
          commandId: command.commandId,
          threadId: command.threadId,
          stopDelegatedTasks: command.stopDelegatedTasks,
        });
        const failure = failures.get(command.threadId);
        return failure === undefined
          ? Effect.succeed({ sequence: 0, storedEvents: [] } as never)
          : Effect.fail(failure as never);
      }) as never,
      searchThread: unused,
      searchThreadStream: () => Stream.empty,
      getThreadHistoryPage: unused,
      getTimelinePage: unused,
      getMessageCount: unused,
      getTurnItem: unused,
      getReviewLedgerEntries: unused,
      getThreadRecords: ((threadId: ThreadId) =>
        (reads.during?.() ?? Effect.void).pipe(
          Effect.andThen(() =>
            reads.failures.has(threadId)
              ? Effect.fail(reads.failures.get(threadId) as never)
              : Effect.succeed({
                  thread: {
                    id: threadId,
                    projectId: "project-1",
                    archivedAt: null,
                    deletedAt: null,
                    pullRequests: [],
                    updatedAt: NOW,
                    activeProviderThreadId: null,
                  },
                  runs: runs.get(threadId) ?? [],
                  runtimeRequests: [],
                  turnItems: [],
                  providerThreads: providerThreads.get(threadId) ?? [],
                  subagents: [],
                  messages: [],
                }),
          ),
        )) as never,
      getThreadProjection: unused,
      getCheckpointContext: unused,
      getThreadSnapshot: unused,
      getThreadTranscript: unused,
      getThreadSnapshotWindow: unused,
      getProjectThreadRecords: unused,
      getProjectThread: unused,
      listProjectThreads: unused,
      sendToThread: unused,
      assertProviderInstanceEnabled: unused,
      isProviderInstanceEnabledForProject: unused,
      hasReceipt: unused,
      receiptStatus: unused,
      waitForThread: unused,
      settleAfterRun: unused,
      settleThread: unused,
      interruptThread: unused,
      stopWorkflow: unused,
      stopDelegatedTasks: unused,
      getThreadEventSequence: unused,
      recoverDelegatedTask: unused,
      delegatedTaskResultPending: unused,
      streamStoredEvents: Stream.empty,
      streamStoredEventsFrom: () => Stream.empty,
      streamDomainEvents: Stream.empty,
    }),
  );

export const makeLayer = (
  runs: ReadonlyMap<string, ReadonlyArray<unknown>> = new Map(),
  failures: ReadonlyMap<string, unknown> = new Map(),
  dispatched: Array<DispatchedStop> = [],
  providerThreads: ReadonlyMap<string, ReadonlyArray<unknown>> = new Map(),
  reads?: RecordReads,
) =>
  ChannelChildWork.layer.pipe(
    Layer.provideMerge(ChannelChildWorkStore.layer),
    Layer.provideMerge(ChannelLedger.layer),
    Layer.provideMerge(threadsLayer(runs, failures, dispatched, providerThreads, reads)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const accept = () => {
  const conversationId = conversationIdFor({
    ownerId: "owner",
    kind: slackMessage.kind,
    connectionId: slackMessage.connectionId,
    conversationKey: slackMessage.conversationKey,
  });
  return ChannelLedger.ChannelLedger.pipe(
    Effect.flatMap((ledger) =>
      ledger.acceptInput({
        ownerId: "owner",
        inputId: inputIdFor({
          ownerId: "owner",
          kind: slackMessage.kind,
          connectionId: slackMessage.connectionId,
          idempotencyKey: slackMessage.idempotencyKey,
        }),
        conversationId,
        bindingId: bindingIdFor(conversationId, "root"),
        message: slackMessage,
        contentHash: contentHashFor(slackMessage),
        requester,
        acceptedAt: NOW,
      }),
    ),
  );
};

export const move = (taskId: ChannelTask["taskId"], spec: ChannelTaskEventSpec) =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const stored = yield* ledger.getTask(taskId);
    if (stored === undefined) return yield* Effect.die("task missing");
    const prepared = prepareTransition(stored, spec, NOW, undefined);
    if (!prepared.ok) return yield* Effect.die("transition rejected: " + prepared.reason);
    yield* ledger.applyTaskEvent({
      owner: "cw-owner",
      write: prepared.write,
      deliveries: prepared.deliveries,
    });
  });

/** A channel task in generation 1 whose bound worker is the given thread. */
export const seedChannelWorker = Effect.fnUntraced(function* (worker: ThreadId) {
  const ledger = yield* ChannelLedger.ChannelLedger;
  yield* ledger.claimOwnership({
    token: "cw-owner",
    now: NOW,
    staleBefore: "2026-10-11T23:59:30.000Z",
  });
  const input = yield* accept();
  yield* ledger.beginReception({
    owner: "cw-owner",
    inputId: input.inputId,
    receptionId: "cw-r" as never,
    readAt: NOW,
  });
  const taskId = taskIdFor(input.inputId, 0);
  const task = decodeTask({
    taskId,
    conversationId: input.conversationId,
    originBindingId: input.bindingId,
    originAddress: slackMessage.replyAddress,
    originInputId: input.inputId,
    requester,
    title: "Audit the release.",
    instruction: "Audit the release.",
    status: "received",
    version: 1,
    generation: 1,
    openQuestions: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const event = decodeEvent({
    eventId: taskEventIdFor(taskId, 1),
    sequence: 0,
    taskId,
    taskVersion: 1,
    occurredAt: NOW,
    actor: "system",
    type: "task.created",
    payload: { title: task.title, instruction: task.instruction, originInputId: input.inputId },
  });
  yield* ledger.completeReception({
    owner: "cw-owner",
    inputId: input.inputId,
    receptionId: "cw-r" as never,
    replyText: "Starting.",
    decision: { replyText: "Starting.", action: { type: "report_only" } },
    createdTask: { task, event },
    deliveries: [],
    now: NOW,
  });
  yield* move(taskId, {
    type: "task.dispatch.claimed",
    payload: { generation: 1, target, leaseExpiresAt: NOW },
  });
  yield* move(taskId, {
    type: "task.worker.bound",
    payload: {
      worker: {
        environmentId: "env-1" as never,
        threadId: worker as never,
        runId: "run-1" as never,
        generation: 1,
      },
    },
  });
  return taskId;
});

export const seedWorker = seedChannelWorker(workerThread);

export const admit = (
  prompt: string,
  options?: {
    readonly callerThreadId?: ThreadId;
    readonly surface?: "delegate_local" | "delegate_remote" | "thread_launch" | "ssh_thread_launch";
    readonly destinationKey?: string;
    readonly clientRequestId?: string;
  },
) =>
  ChannelChildWork.ChannelChildWork.pipe(
    Effect.flatMap((childWork) =>
      childWork.admit({
        callerThreadId: options?.callerThreadId ?? workerThread,
        surface: options?.surface ?? "delegate_local",
        prompt,
        destinationKey: options?.destinationKey ?? "codex/gpt-6.1-sol",
        ...(options?.clientRequestId === undefined
          ? {}
          : { clientRequestId: options.clientRequestId }),
      }),
    ),
  );

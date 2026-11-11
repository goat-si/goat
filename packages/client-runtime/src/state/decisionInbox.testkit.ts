import {
  type DecisionFeed,
  EnvironmentId,
  type Handoff,
  ProviderInstanceId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { EnvironmentPresentation } from "../connection/presentation.ts";
import { PrimaryConnectionTarget } from "../connection/model.ts";
import { createDecisionInboxAtoms, type DecisionItem } from "./decisionInbox.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { threadKey } from "./entities.ts";
import { presentThreadShell } from "./models.ts";
import { v2Now, v2Projection, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threadState.ts";

export const a = EnvironmentId.make("a");
export const b = EnvironmentId.make("b");
export const ref = (environmentId = a, id = "thread") => ({
  environmentId,
  threadId: ThreadId.make(id),
});
export const shell = (scope: ScopedThreadRef, overrides: Partial<typeof v2ThreadShell> = {}) =>
  presentThreadShell(scope.environmentId, {
    ...v2ThreadShell,
    id: scope.threadId,
    pendingRuntimeRequest: { id: RuntimeRequestId.make("flag"), kind: "command", createdAt: v2Now },
    ...overrides,
  });
export const request = (
  id: string,
  createdAt: string,
): OrchestrationV2ThreadProjection["runtimeRequests"][number] => ({
  id: RuntimeRequestId.make(id),
  nodeId: NodeId.make("node"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "command",
  status: "pending",
  responseCapability: { type: "not_resumable", reason: "Provider session cannot be resumed" },
  createdAt: DateTime.makeUnsafe(createdAt),
  resolvedAt: null,
});
export function harness() {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  const entries = new Map(
    [a, b].map((environmentId) => [
      environmentId,
      {
        target: new PrimaryConnectionTarget({
          environmentId,
          label: environmentId,
          httpBaseUrl: "https://example.test",
          wsBaseUrl: "wss://example.test",
        }),
        profile: Option.none(),
        enabled: true,
      },
    ]),
  );
  const catalog = Atom.make<EnvironmentCatalogState>({ isReady: true, entries });
  const presentations = Atom.family((id: EnvironmentId) => {
    const entry = entries.get(id);
    return Atom.make<EnvironmentPresentation | null>(
      entry === undefined
        ? null
        : {
            entry,
            connection: { phase: "connected", error: null, traceId: null },
            serverConfig: null,
          },
    );
  });
  const shells = Atom.make([shell(ref(a)), shell(ref(b))]);
  const data = Atom.family((_key: string) =>
    Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(Atom.keepAlive),
  );
  const activeSources = new Set<string>();
  const sourceReads = new Map<string, number>();
  const sources = Atom.family((key: string) =>
    Atom.make((get) => {
      activeSources.add(key);
      sourceReads.set(key, (sourceReads.get(key) ?? 0) + 1);
      get.addFinalizer(() => activeSources.delete(key));
      return get(data(key));
    }).pipe(Atom.setIdleTTL(0)),
  );
  const details = createEnvironmentThreadDetailAtoms((env, thread) =>
    sources(threadKey({ environmentId: env, threadId: thread })),
  );
  let detailReads = 0;
  const feeds = Atom.family((_id: EnvironmentId) => Atom.make<DecisionFeed | null>(null));
  const inbox = createDecisionInboxAtoms({
    catalogValueAtom: catalog,
    threadShellsAtom: shells,
    presentationAtom: presentations,
    feedAtom: feeds,
    details: {
      ...details,
      pendingRequestsAtom: (scope) => {
        detailReads += 1;
        return details.pendingRequestsAtom(scope);
      },
    },
  });
  const set = (
    scope: ScopedThreadRef,
    requests: OrchestrationV2ThreadProjection["runtimeRequests"],
    status: EnvironmentThreadState["status"] = "live",
    error: string | null = null,
    turnItems: OrchestrationV2ThreadProjection["turnItems"] = [],
  ) =>
    registry.set(
      data(threadKey(scope)),
      AsyncResult.success({
        ...EMPTY_ENVIRONMENT_THREAD_STATE,
        status,
        error: Option.fromNullOr(error),
        data:
          status === "deleted"
            ? Option.none()
            : Option.some({
                ...v2Projection,
                thread: { ...v2Projection.thread, id: scope.threadId },
                runtimeRequests: requests,
                turnItems,
              }),
      }),
    );
  return {
    registry,
    catalog,
    presentations,
    shells,
    inbox,
    feeds,
    details,
    set,
    flush,
    activeSources,
    sourceReads,
    detailReads: () => detailReads,
  };
}
export const requestOf = (entry: DecisionItem) => {
  if (entry.kind === "decision" || entry.kind === "handoff")
    throw new Error("Expected a thread request");
  return entry.request;
};
export const item = (id: string, createdAt: string): DecisionItem => ({
  id,
  createdAt,
  ref: ref(),
  routing: { routedTo: "person" },
  kind: "approval",
  request: {
    requestId: RuntimeRequestId.make(id),
    requestKind: "command",
    createdAt,
    responseCapability: "live",
  },
});

export const questionItem: OrchestrationV2ThreadProjection["turnItems"][number] = {
  id: TurnItemId.make("inbox-question-item"),
  threadId: ref(a).threadId,
  runId: null,
  nodeId: NodeId.make("node"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: v2Now,
  completedAt: v2Now,
  updatedAt: v2Now,
  type: "user_input_request",
  requestId: RuntimeRequestId.make("question"),
  responseMode: "message",
  questions: [
    {
      id: "next",
      header: "Next",
      question: "What should happen next?",
      required: true,
      allowCustomAnswer: false,
      multiSelect: false,
      options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
    },
  ],
};
export const approval = (id: string): Handoff => ({
  handoffId: TurnItemId.make(id),
  kind: "approval",
  title: `Approve ${id}`,
  reason: "Needed",
  requestedBy: {
    threadId: ref(a).threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    path: "hub.device_join",
  },
  target: { environmentId: a, path: "hub.device_join" },
  dedupeKey: id,
  state: "pending",
  expiresAt: null,
  createdAt: v2Now,
  actor: { type: "agent", threadId: ref(a).threadId },
});
export const handoffItem = (
  handoff: Handoff,
): OrchestrationV2ThreadProjection["turnItems"][number] => ({
  ...questionItem,
  id: handoff.handoffId,
  status: handoff.state === "pending" ? "waiting" : "completed",
  type: "human_handoff",
  handoff,
});

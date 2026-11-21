import {
  pendingDecisionId,
  TurnItemId,
  isHandoffPending,
  type DecisionFeed,
  type DecisionItem,
  type ChannelTask,
  type ChannelTaskApprovalRef,
  type EnvironmentId,
  type RuntimeRequestId,
  type ScopedThreadRef,
} from "@goat/contracts";
import {
  ChannelAttentionRequest,
  type ChannelAttentionEvent,
  type ChannelAttentionTarget,
  type GoatBotAlerts,
} from "@goat/contracts/channel-bot-attention";
import type { Atom, AtomRegistry } from "effect/reactivity";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import type { createDecisionEnvironmentAtoms } from "../state/decisionRpc.ts";
import type { createOrchestrationEnvironmentAtoms } from "../state/orchestration.ts";
import type { createChannelEnvironmentAtoms } from "../state/channels.ts";
import { runAtomCommand } from "../state/runtime.ts";

export const goatBotAlertChoices = [
  { value: "needs_you", label: "Needs you" },
  { value: "needs_you_and_results", label: "Needs you and results" },
  { value: "off", label: "Off" },
] as const satisfies ReadonlyArray<{ value: GoatBotAlerts; label: string }>;

const messages = {
  question: "has a question",
  approval: "needs approval",
  sign_in: "needs you to sign in",
  failed: "couldn’t finish",
  finished: "finished",
} satisfies Record<ChannelAttentionEvent["kind"], string>;

export const goatBotAttentionTitle = (event: ChannelAttentionEvent) =>
  `${event.botName} ${messages[event.kind]}`;

export const allowsGoatBotAlert = (mode: GoatBotAlerts, event: ChannelAttentionEvent) =>
  mode === "needs_you_and_results" ||
  (mode === "needs_you" && event.kind !== "failed" && event.kind !== "finished");

type Channels = ReturnType<typeof createChannelEnvironmentAtoms>;

export const attentionCursorKey = (id: EnvironmentId) =>
  "goat.bot-attention.cursor." + encodeURIComponent(id);

const drains = new Map<EnvironmentId, Promise<void>>();

/** One reader per connected environment. The stream only wakes a bounded cursor walk. */
export function watchGoatBotAttention(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly channels: Channels;
  readonly environmentId: EnvironmentId;
  readonly readCursor: () => Promise<number | undefined>;
  readonly writeCursor: (cursor: number) => Promise<void>;
  readonly present: (
    event: ChannelAttentionEvent,
    mode: GoatBotAlerts,
    active: () => boolean,
  ) => void | Promise<void>;
  readonly onError: (cause: unknown) => void;
  readonly handoffFeed?: Atom.Atom<DecisionFeed | null>;
  readonly withLock?: (read: () => Promise<void>) => Promise<void>;
}): () => void {
  const { registry, channels, environmentId } = input;
  const permitted = () => registry.get(channels.listBotAttention.permissionAtom(environmentId));
  let stopped = false;
  const active = () => !stopped && permitted();
  let reading = false;
  let dirty = false;
  const drain = async () => {
    if (!active()) return;
    let cursor = await input.readCursor();
    // A continuously busy producer cannot monopolize the reader.
    for (let page = 0; page < 10; page++) {
      if (!active()) return;
      const response = await runAtomCommand(
        registry,
        channels.listBotAttention,
        { environmentId, input: cursor === undefined ? {} : { cursor } },
        { reportFailure: false },
      );
      if (!active() || response._tag !== "Success") return;
      const batch = response.value;
      for (const event of batch.events) {
        if (!active()) return;
        if (event.environmentId !== environmentId || event.sequence <= (cursor ?? -1)) continue;
        // Save first so a restart or another window cannot present the same event again.
        await input.writeCursor(event.sequence);
        cursor = event.sequence;
        if (active()) await input.present(event, batch.mode, active);
      }
      if (!active()) return;
      if (batch.cursor > (cursor ?? -1)) {
        await input.writeCursor(batch.cursor);
        cursor = batch.cursor;
      }
      if (!batch.hasMore) return;
    }
  };
  const drainSerially = async () => {
    // Replaced watchers share the same cursor, including while a native presentation is pending.
    let pending = drains.get(environmentId);
    while (pending !== undefined) {
      await pending.catch(() => undefined);
      if (!active()) return;
      pending = drains.get(environmentId);
    }
    if (!active()) return;
    const running = Promise.resolve().then(() => {
      if (!active()) return;
      return input.withLock === undefined ? drain() : input.withLock(drain);
    });
    drains.set(environmentId, running);
    try {
      await running;
    } finally {
      drains.delete(environmentId);
    }
  };
  const read = async () => {
    if (reading || stopped) return;
    reading = true;
    try {
      do {
        dirty = false;
        await drainSerially();
        if (stopped) break;
      } while (dirty);
    } catch (cause) {
      input.onError(cause);
    } finally {
      reading = false;
    }
  };
  const requestRead = () => {
    dirty = true;
    void read();
  };
  const unsubscribe = registry.subscribe(
    channels.taskChanges({ environmentId, input: {} }),
    (result) => {
      const event = AsyncResult.value(result);
      if (Option.isSome(event) && "value" in event.value) requestRead();
    },
    { immediate: true },
  );
  let handoffVersion: number | DecisionFeed["handoffs"];
  const stopHandoffs =
    input.handoffFeed === undefined
      ? undefined
      : registry.subscribe(
          input.handoffFeed,
          (feed) => {
            const version = feed?.handoffRevision ?? feed?.handoffs;
            if (version === handoffVersion) return;
            handoffVersion = version;
            requestRead();
          },
          { immediate: true },
        );
  return () => {
    stopped = true;
    unsubscribe();
    stopHandoffs?.();
  };
}

const matchesNativeRequest = (left: ChannelTaskApprovalRef, right: ChannelTaskApprovalRef) =>
  left.threadId === right.threadId &&
  left.requestId === right.requestId &&
  left.host === right.host;

export async function readGoatBotAttentionTarget(
  registry: AtomRegistry.AtomRegistry,
  channels: Channels,
  target: ChannelAttentionTarget,
) {
  const result = await runAtomCommand(
    registry,
    channels.readAttentionTask,
    {
      environmentId: target.environmentId,
      input: {
        taskId: target.taskId,
        botId: target.botId,
        ...(target.request === undefined && target.requestId !== undefined
          ? { attentionRequest: target.requestId }
          : {}),
      },
    },
    { reportFailure: false },
  );
  if (
    result._tag !== "Success" ||
    !registry.get(channels.listBotAttention.permissionAtom(target.environmentId))
  )
    return null;
  const task = result.value;
  if (target.generation !== undefined && target.generation !== task.generation) return { task };
  const request = nativeAttentionRequest(task, target.requestId, target.request);
  return {
    task,
    ...(request === undefined ? {} : { request }),
    ...(target.request === undefined && botAttentionRequest(task, target.requestId) !== null
      ? { requestId: target.requestId }
      : {}),
  };
}

function nativeAttentionRequest(
  task: ChannelTask,
  requestId: string | undefined,
  ref: ChannelAttentionRequest | undefined,
): ChannelAttentionRequest | undefined {
  if (ref?.kind === "handoff") {
    return ref.host === undefined &&
      task.worker?.host === undefined &&
      task.worker?.threadId === ref.threadId
      ? ref
      : undefined;
  }
  if (ref !== undefined) {
    return task.observed?.needsYou.some(
      ({ approval, question }) =>
        (approval !== undefined && matchesNativeRequest(approval, ref)) ||
        (question !== undefined && matchesNativeRequest(question, ref)),
    )
      ? ref
      : undefined;
  }
  const legacy = botAttentionRequest(task, requestId);
  return legacy?.kind === "approval" || legacy?.kind === "worker_question"
    ? { ...legacy.request, kind: "runtime" }
    : undefined;
}

const attentionRequestJson = Schema.fromJsonString(ChannelAttentionRequest);
export const encodeBotAttentionRequest = Schema.encodeSync(attentionRequestJson);
const decodeAttentionRequest = Schema.decodeUnknownOption(attentionRequestJson);
export const decodeBotAttentionRequest = (value: unknown) =>
  typeof value === "string" && value.length <= 4096
    ? Option.getOrUndefined(decodeAttentionRequest(value))
    : undefined;

export function botAttentionRequest(task: ChannelTask, requestId: string | undefined) {
  const question = task.openQuestions.find((item) => item.questionId === requestId);
  if (question !== undefined) return { kind: "question" as const, text: question.text };
  const answer = task.answeredQuestions?.find((item) => item.questionId === requestId);
  if (answer !== undefined) return { kind: "answered" as const, text: answer.answerText };
  const matches = (task.observed?.needsYou ?? []).flatMap<{
    readonly kind: "approval" | "worker_question";
    readonly request: ChannelTaskApprovalRef;
  }>((need) =>
    need.approval !== undefined && need.approval.requestId === requestId
      ? [{ kind: "approval" as const, request: need.approval }]
      : need.question !== undefined && need.question.requestId === requestId
        ? [{ kind: "worker_question" as const, request: need.question }]
        : [],
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

type DecisionRequestTarget = ScopedThreadRef & { readonly requestId: RuntimeRequestId };

export type BotAttentionDecisionResolver = (
  request: ChannelAttentionRequest,
  task: ChannelTask,
) => Promise<DecisionRequestTarget | null>;

type DecisionRpc = Pick<
  ReturnType<typeof createDecisionEnvironmentAtoms>,
  "getDecision" | "answerDecision"
>;

export const botAttentionDecisionInput = (request: ChannelAttentionRequest) => ({
  id: pendingDecisionId(request.threadId, request.requestId),
  ...(request.host === undefined ? {} : { host: request.host }),
});

export function botAttentionRemoteApproval(task: ChannelTask, request: ChannelAttentionRequest) {
  return (
    request.kind === "runtime" &&
    request.host !== undefined &&
    (task.observed?.needsYou.some(
      ({ approval }) => approval !== undefined && matchesNativeRequest(approval, request),
    ) ??
      false)
  );
}

export const isOpenBotAttentionDecision = (item: DecisionItem, request: ChannelAttentionRequest) =>
  item.id === pendingDecisionId(request.threadId, request.requestId) &&
  item.status === "open" &&
  item.from.host === request.host &&
  item.pending?.threadId === request.threadId &&
  item.pending.requestId === request.requestId;

export async function readBotAttentionRuntimeDecision(
  registry: AtomRegistry.AtomRegistry,
  decisionRpc: Pick<DecisionRpc, "getDecision">,
  environmentId: EnvironmentId,
  request: ChannelAttentionRequest,
) {
  const input = botAttentionDecisionInput(request);
  const result = await runAtomCommand(
    registry,
    decisionRpc.getDecision,
    { environmentId, input },
    { reportFailure: false },
  );
  return result._tag === "Success" && isOpenBotAttentionDecision(result.value, request)
    ? result.value
    : null;
}

export async function resolveBotAttentionDecision(
  registry: AtomRegistry.AtomRegistry,
  services: {
    readonly decisions: Pick<DecisionRpc, "getDecision">;
    readonly orchestration: Pick<
      ReturnType<typeof createOrchestrationEnvironmentAtoms>,
      "readTurnItem"
    >;
    readonly connected: (id: EnvironmentId) => boolean;
  },
  origin: EnvironmentId,
  task: ChannelTask,
  request: ChannelAttentionRequest,
): Promise<DecisionRequestTarget | null> {
  const { host, threadId, requestId } = request;
  const environmentId =
    host === undefined
      ? origin
      : task.worker?.host === host
        ? task.worker?.environmentId
        : (await readBotAttentionRuntimeDecision(registry, services.decisions, origin, request))
            ?.from.environmentId;
  if (environmentId === undefined || !services.connected(environmentId)) return null;
  if (request.kind === "handoff") {
    const result = await runAtomCommand(
      registry,
      services.orchestration.readTurnItem,
      {
        environmentId,
        input: { threadId, itemId: TurnItemId.make(requestId) },
      },
      { reportFailure: false },
    );
    const item = result._tag === "Success" ? result.value.item : null;
    if (
      item?.type !== "human_handoff" ||
      item.threadId !== threadId ||
      item.handoff.handoffId !== String(requestId) ||
      item.handoff.kind !== "approval" ||
      !isHandoffPending(item.handoff.state)
    )
      return null;
  } else {
    const item = await readBotAttentionRuntimeDecision(
      registry,
      services.decisions,
      environmentId,
      {
        kind: "runtime",
        threadId,
        requestId,
      },
    );
    if (item?.from.environmentId !== environmentId) return null;
  }
  return { environmentId, threadId, requestId };
}

export async function answerBotAttentionApproval(
  registry: AtomRegistry.AtomRegistry,
  channels: Channels,
  decisions: DecisionRpc,
  target: ChannelAttentionTarget,
  decision: "accept" | "decline",
  destination: EnvironmentId,
) {
  const fresh = await readGoatBotAttentionTarget(registry, channels, target);
  if (fresh === null) return false;
  const request = fresh.request;
  if (request === undefined || !botAttentionRemoteApproval(fresh.task, request)) return false;
  const environmentId = target.environmentId;
  const current = await readBotAttentionRuntimeDecision(
    registry,
    decisions,
    environmentId,
    request,
  );
  if (
    current?.pending?.approval === undefined ||
    current.from.environmentId !== destination ||
    !registry.get(channels.listBotAttention.permissionAtom(environmentId))
  )
    return false;
  const result = await runAtomCommand(
    registry,
    decisions.answerDecision,
    {
      environmentId,
      input: {
        ...botAttentionDecisionInput(request),
        decision,
        reason: decision === "accept" ? "Approved in GOAT Bot." : "Declined in GOAT Bot.",
      },
    },
    { reportFailure: false },
  );
  return result._tag === "Success";
}

export function botAttentionDecisionTarget(
  origin: EnvironmentId,
  task: ChannelTask,
  requestId: string | undefined,
): DecisionRequestTarget | null {
  const current = nativeAttentionRequest(task, requestId, undefined);
  if (current === undefined) return null;
  const { host, threadId, requestId: nativeRequestId } = current;
  const environmentId =
    host === undefined
      ? origin
      : task.worker?.host === host
        ? task.worker?.environmentId
        : undefined;
  return environmentId === undefined
    ? null
    : { environmentId, threadId, requestId: nativeRequestId };
}

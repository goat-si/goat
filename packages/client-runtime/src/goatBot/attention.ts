import type { ChannelTask, EnvironmentId } from "@goat/contracts";
import type {
  ChannelAttentionEvent,
  ChannelAttentionTarget,
  GoatBotAlerts,
} from "@goat/contracts/channel-bot-attention";
import type { AtomRegistry } from "effect/reactivity";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";

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
  return () => {
    stopped = true;
    unsubscribe();
  };
}

function currentAttentionRequest(task: ChannelTask, target: ChannelAttentionTarget) {
  if (
    target.requestId === undefined ||
    (target.generation !== undefined && target.generation !== task.generation)
  )
    return undefined;
  const request = target.requestId;
  return task.openQuestions.some((item) => item.questionId === request) ||
    task.answeredQuestions?.some((item) => item.questionId === request) === true ||
    task.observed?.needsYou.some(
      (need) => need.question?.requestId === request || need.approval?.requestId === request,
    ) === true
    ? request
    : undefined;
}

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
        ...(target.requestId === undefined ? {} : { attentionRequest: target.requestId }),
      },
    },
    { reportFailure: false },
  );
  if (
    result._tag !== "Success" ||
    !registry.get(channels.listBotAttention.permissionAtom(target.environmentId))
  )
    return null;
  return { task: result.value, requestId: currentAttentionRequest(result.value, target) };
}

export function botAttentionRequest(task: ChannelTask, requestId: string | undefined) {
  const question = task.openQuestions.find((item) => item.questionId === requestId);
  if (question !== undefined) return { kind: "question" as const, text: question.text };
  const answer = task.answeredQuestions?.find((item) => item.questionId === requestId);
  if (answer !== undefined) return { kind: "answered" as const, text: answer.answerText };
  for (const need of task.observed?.needsYou ?? []) {
    if (need.approval !== undefined && need.approval.requestId === requestId)
      return { kind: "approval" as const, request: need.approval };
    if (need.question !== undefined && need.question.requestId === requestId)
      return { kind: "worker_question" as const, request: need.question };
  }
  return null;
}

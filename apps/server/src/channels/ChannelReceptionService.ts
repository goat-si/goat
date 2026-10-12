/**
 * ChannelReceptionService - reads one channel input and answers it right away.
 *
 * Each input gets its own pass with its own reception id; nothing waits on another input or on
 * a provider session. The model (a tool-free one-shot text generation) proposes a reply and an
 * action; this service checks the action against the ledger and the requester's permissions,
 * then commits the reply, any new task, and their deliveries in one transaction.
 *
 * The same service words task updates for the requester (`narrate`) when the ledger records a
 * result, failure, or question.
 *
 * @module ChannelReceptionService
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- reception ids only need a random UUID.
import * as NodeCrypto from "node:crypto";

import {
  type ChannelInputId,
  type ChannelReceptionInput,
  type ChannelReceptionResult,
  type ChannelReplyAddress,
  type ChannelTask,
  ChannelReceptionId,
  CHANNEL_RECEPTION_TAIL_LIMITS,
  type ChannelOutboundKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ChannelBotTimeline from "./ChannelBotTimeline.ts";
import { lowerRuntimeMode, mayAnswerFor } from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRemoteWorkers from "./ChannelRemoteWorkers.ts";
import * as ChannelWake from "./ChannelWake.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import { answerForwardIdsFor, deliveryIdFor, taskEventIdFor, taskIdFor } from "./channelIds.ts";
import { botAddress, chipDelivery, makeTaskEvent, prepareTransition } from "./channelTaskWrites.ts";

/** How long a reception pass may take before the sender gets a failure note instead. */
const CHANNEL_RECEPTION_TIMEOUT_MS = 45_000;

export class ChannelReceptionService extends Context.Service<
  ChannelReceptionService,
  {
    /** Answers one input. Does nothing when the input already finished or another pass owns it. */
    readonly receive: (
      inputId: ChannelInputId,
      owner: string,
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
    /** Words one task update for the requester and commits its deliveries. */
    readonly narrate: (
      pending: ChannelLedger.ChannelPendingEvent,
      owner: string,
    ) => Effect.Effect<void, ChannelLedger.ChannelLedgerError>;
  }
>()("t3/channels/ChannelReceptionService") {}

const replyDelivery = (input: {
  readonly causeKey: string;
  readonly destination: ChannelReplyAddress;
  readonly kind: ChannelOutboundKind;
  readonly text: string;
  readonly inputId?: ChannelInputId | undefined;
  readonly task?: ChannelTask | undefined;
  readonly mentionActorId?: string | undefined;
}): ChannelLedger.ChannelOutboxInsert => {
  const deliveryId = deliveryIdFor(input.causeKey);
  return {
    deliveryId,
    causeKey: input.causeKey,
    ...(input.inputId === undefined ? {} : { inputId: input.inputId }),
    ...(input.task === undefined ? {} : { taskId: input.task.taskId }),
    message: {
      deliveryId,
      destination: input.destination,
      kind: input.kind,
      text: input.text,
      ...(input.inputId === undefined ? {} : { inReplyToInputId: input.inputId }),
      ...(input.task === undefined
        ? {}
        : { taskId: input.task.taskId, taskVersion: input.task.version }),
      ...(input.mentionActorId === undefined ? {} : { mentionActorId: input.mentionActorId }),
    },
  };
};

/** Slack replies tag the person; the GOAT bot and MCP do not. */
const mentionFor = (address: ChannelReplyAddress, externalActorId: string | undefined) =>
  address.kind === "slack" ? externalActorId : undefined;

/** Keeps the newest tail entries that fit the byte budget. */
const boundTail = (
  entries: ReadonlyArray<ChannelReceptionInput["tail"][number]>,
): ChannelReceptionInput["tail"] => {
  const kept: Array<ChannelReceptionInput["tail"][number]> = [];
  let bytes = 0;
  for (const entry of entries.toReversed()) {
    bytes += entry.text.length;
    if (bytes > CHANNEL_RECEPTION_TAIL_LIMITS.bytes) break;
    kept.unshift(entry);
  }
  return kept;
};

const make = Effect.gen(function* () {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const timeline = yield* ChannelBotTimeline.ChannelBotTimeline;
  const wake = yield* ChannelWake.ChannelWake;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const remoteWorkers = yield* ChannelRemoteWorkers.ChannelRemoteWorkers;

  const allowedTargets = Effect.gen(function* () {
    const shells = yield* projects.listShells().pipe(Effect.orElseSucceed(() => []));
    return shells.map((shell) => ({ projectId: shell.id, label: shell.title }));
  });

  const generate = (input: ChannelReceptionInput) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(Effect.option);
      const generateReception = textGeneration.generateChannelReception;
      if (Option.isNone(settings) || generateReception === undefined) {
        return Option.none<ChannelReceptionResult>();
      }
      return yield* generateReception({
        cwd: serverConfig.stateDir,
        input,
        modelSelection: settings.value.textGenerationModelSelection,
      }).pipe(
        Effect.timeoutOption(CHANNEL_RECEPTION_TIMEOUT_MS),
        Effect.tapError((cause) => Effect.logWarning("channel reception failed", { cause })),
        Effect.orElseSucceed(() => Option.none<ChannelReceptionResult>()),
      );
    });

  const receive: ChannelReceptionService["Service"]["receive"] = (inputId, owner) =>
    Effect.gen(function* () {
      const receptionId = ChannelReceptionId.make("channel-reception:" + NodeCrypto.randomUUID());
      const readAt = DateTime.formatIso(yield* DateTime.now);
      const stored = yield* ledger.beginReception({ owner, inputId, receptionId, readAt });
      if (stored === undefined || stored.requester === undefined) return;
      const message = stored.message;
      const requester = stored.requester;
      const conversationId = stored.snapshot.conversationId;
      const origin = message.replyAddress;
      const mention = mentionFor(origin, message.actor.externalActorId);

      // The bot's copy of the message shows when reception started reading it.
      if (origin.kind === "goat") {
        yield* timeline
          .record({
            threadId: origin.threadId,
            record: {
              recordKey: "input:" + inputId,
              entry: {
                type: "message",
                role: "user",
                text: message.text,
                meta: {
                  conversationId,
                  originKind: "goat",
                  kind: "inbound",
                  inputId,
                  readAt: stored.snapshot.readAt ?? readAt,
                },
              },
            },
            revision: "read",
          })
          .pipe(Effect.ignore);
      }

      const tasks = yield* ledger.listConversationTasks(conversationId);
      const targets = yield* allowedTargets;
      const hosts = yield* remoteWorkers.knownHosts;
      const decision: ChannelReceptionResult | undefined =
        message.intent === "answer" &&
        message.taskId !== undefined &&
        message.questionId !== undefined
          ? {
              replyText: CHANNEL_COPY.answerForwarded,
              action: {
                type: "answer_question",
                taskId: message.taskId,
                questionId: message.questionId,
                answer: message.text.trim() === "" ? "(no answer)" : message.text,
              },
            }
          : Option.getOrUndefined(
              yield* Effect.gen(function* () {
                const tail = yield* ledger.readConversationTail(
                  conversationId,
                  CHANNEL_RECEPTION_TAIL_LIMITS.messages,
                );
                return yield* generate({
                  mode: "input",
                  conversationId,
                  originKind: message.kind,
                  inputText: message.text,
                  tail: boundTail(
                    tail.flatMap((entry) =>
                      entry.inputId === inputId
                        ? []
                        : [
                            { role: "user" as const, text: entry.text, at: entry.receivedAt },
                            ...(entry.replyText === undefined
                              ? []
                              : [
                                  {
                                    role: "assistant" as const,
                                    text: entry.replyText,
                                    at: entry.receivedAt,
                                  },
                                ]),
                          ],
                    ),
                  ),
                  tasks: tasks.map((task) => ({
                    taskId: task.taskId,
                    title: task.title,
                    status: task.status,
                    ...(task.resultSummary === undefined
                      ? {}
                      : { resultSummary: task.resultSummary }),
                    openQuestions: task.openQuestions.map((question) => ({
                      questionId: question.questionId,
                      text: question.text,
                    })),
                  })),
                  allowedTargets: targets,
                  ...(hosts.length === 0 ? {} : { allowedHosts: hosts }),
                  requester,
                });
              }),
            );

      const now = DateTime.formatIso(yield* DateTime.now);
      if (decision === undefined) {
        yield* ledger.failReception({
          owner,
          inputId,
          receptionId,
          failure: { reason: "reception_failed", message: CHANNEL_COPY.receptionFailed },
          deliveries: [
            replyDelivery({
              causeKey: "reply:" + inputId,
              destination: origin,
              kind: "failure",
              text: CHANNEL_COPY.receptionFailed,
              inputId,
              mentionActorId: mention,
            }),
          ],
          now,
        });
        yield* wake.wake;
        return;
      }

      const bot = (yield* ledger.getBot(stored.ownerId))?.bot;
      let replyText = decision.replyText;
      let finalDecision = decision;
      let createdTask:
        | { readonly task: ChannelTask; readonly event: ReturnType<typeof makeTaskEvent> }
        | undefined;
      const taskEvents: Array<ChannelLedger.ChannelTaskEventWrite> = [];
      const deliveries: Array<ChannelLedger.ChannelOutboxInsert> = [];
      const action = decision.action;

      if (action.type === "create_task") {
        // People start work; agents may only report on or answer existing work.
        if (
          requester.originKind === "mcp" ||
          !requester.grantedScopes.includes("orchestration:operate")
        ) {
          replyText = CHANNEL_COPY.agentCannotCreateWork;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else {
          const taskId = taskIdFor(inputId, 0);
          const task: ChannelTask = {
            taskId,
            conversationId,
            originBindingId: stored.snapshot.bindingId,
            originAddress: origin,
            originInputId: inputId,
            requester,
            title: action.title,
            instruction: action.instruction,
            status: "received",
            version: 1,
            generation: 1,
            ...(action.projectId === undefined ? {} : { projectId: action.projectId }),
            // The dispatcher checks the host again before anything runs there.
            ...(action.host === undefined ? {} : { host: action.host }),
            openQuestions: [],
            createdAt: now,
            updatedAt: now,
          };
          createdTask = {
            task,
            event: makeTaskEvent(
              { ...task, version: 0 },
              {
                type: "task.created",
                payload: {
                  title: task.title,
                  instruction: task.instruction,
                  originInputId: inputId,
                },
              },
              now,
              { eventId: taskEventIdFor(taskId, 1) },
            ),
          };
          if (bot !== undefined) deliveries.push(chipDelivery(task, bot));
        }
      }

      if (action.type === "answer_question") {
        // Judge the answerer as they stand now: a Slack link removed or narrowed since the message
        // arrived counts.
        const linked =
          message.kind === "slack" && requester.externalActorId !== undefined
            ? yield* ledger.findIdentity({
                connectionId: message.connectionId,
                externalActorId: requester.externalActorId,
              })
            : undefined;
        const answerer =
          message.kind !== "slack"
            ? requester
            : linked === undefined
              ? undefined
              : {
                  ...requester,
                  runtimeModeCeiling: lowerRuntimeMode(
                    requester.runtimeModeCeiling,
                    linked.runtimeModeCeiling,
                  ),
                  grantedScopes: requester.grantedScopes.filter((scope) =>
                    linked.grantedScopes.includes(scope),
                  ),
                };
        const stored = yield* ledger.getTask(action.taskId);
        const open =
          stored !== undefined &&
          stored.task.conversationId === conversationId &&
          stored.task.openQuestions.some((question) => question.questionId === action.questionId);
        if (stored === undefined || !open) {
          replyText = "I couldn't match that to an open question. Which task do you mean?";
          finalDecision = { replyText, action: { type: "clarify", question: replyText } };
        } else if (answerer === undefined || !mayAnswerFor(answerer, stored.task.requester)) {
          replyText = CHANNEL_COPY.answerNotAllowed;
          finalDecision = { replyText, action: { type: "report_only" } };
        } else {
          const eventId = taskEventIdFor(stored.task.taskId, stored.task.version + 1);
          const hasWorker = stored.task.worker !== undefined;
          // A dispatcher question picks the project: match the answer to a project name or id.
          const answerText = action.answer.toLowerCase();
          const matched = hasWorker
            ? undefined
            : targets.find(
                (target) =>
                  target.projectId === action.answer.trim() ||
                  answerText.includes(target.label.toLowerCase()),
              );
          const prepared = prepareTransition(
            stored,
            {
              type: "task.question.answered",
              payload: { questionId: action.questionId, answer: action.answer },
            },
            now,
            bot,
            {
              actor: "user",
              eventId,
              ...(hasWorker
                ? { forward: true, pendingAnswerMessageId: answerForwardIdsFor(eventId).messageId }
                : {}),
              // A dispatcher question picks the project and may pick the machine: a known
              // host, or this one.
              ...(hasWorker
                ? {}
                : {
                    amend: (next: ChannelTask) => {
                      const machine = ChannelRemoteWorkers.meansThisMachine(action.answer)
                        ? null
                        : hosts
                            .filter((host) => answerText.includes(host.toLowerCase()))
                            .toSorted((left, right) => right.length - left.length)[0];
                      const { host: _host, ...rest } = next;
                      const placed =
                        machine === null
                          ? rest
                          : machine === undefined
                            ? next
                            : { ...rest, host: machine };
                      return matched === undefined
                        ? placed
                        : { ...placed, projectId: matched.projectId };
                    },
                  }),
            },
          );
          if (prepared.ok) {
            taskEvents.push(prepared.write);
            deliveries.push(...prepared.deliveries);
          }
        }
      }

      const relatedTask = createdTask?.task;
      deliveries.unshift(
        replyDelivery({
          causeKey: "reply:" + inputId,
          destination: origin,
          kind: finalDecision.action.type === "clarify" ? "question" : "receipt",
          text: replyText,
          inputId,
          task: relatedTask,
          mentionActorId: mention,
        }),
      );

      const committed = yield* ledger.completeReception({
        owner,
        inputId,
        receptionId,
        replyText,
        decision: finalDecision,
        ...(createdTask === undefined ? {} : { createdTask }),
        taskEvents,
        deliveries,
        now,
      });
      if (!committed) {
        yield* Effect.logDebug("channel reception result dropped; a newer pass owns the input", {
          inputId,
          receptionId,
        });
      }
      yield* wake.wake;
    });

  const narrationFor = (task: ChannelTask, event: ChannelLedger.ChannelPendingEvent["event"]) => {
    switch (event.type) {
      case "task.completed":
        return {
          kind: "result" as const,
          text:
            "Done: " +
            task.title +
            (event.payload.summary.trim() === "" ? "" : "\n" + event.payload.summary),
        };
      case "task.failed":
        return {
          kind: "failure" as const,
          text:
            "Couldn't finish: " +
            task.title +
            " — " +
            (event.payload.summary ?? event.payload.reason),
        };
      case "task.cancelled":
        return { kind: "failure" as const, text: "Stopped: " + task.title };
      case "task.question.opened":
        return { kind: "question" as const, text: event.payload.question.text };
      default:
        return undefined;
    }
  };

  const narrate: ChannelReceptionService["Service"]["narrate"] = (pending, owner) =>
    Effect.gen(function* () {
      const stored = yield* ledger.getTask(pending.event.taskId);
      const now = DateTime.formatIso(yield* DateTime.now);
      const base = stored === undefined ? undefined : narrationFor(stored.task, pending.event);
      if (stored === undefined || base === undefined) {
        yield* ledger.completeNarration({ owner, sequence: pending.sequence, deliveries: [], now });
        return;
      }
      const task = stored.task;
      // Questions keep their exact words; results and failures may be phrased by the model.
      const worded =
        base.kind === "question"
          ? base.text
          : Option.match(
              yield* generate({
                mode: "task_event",
                conversationId: task.conversationId,
                originKind: task.requester.originKind,
                taskEvent: { taskId: task.taskId, type: pending.event.type, summary: base.text },
                tail: [],
                tasks: [],
                allowedTargets: [],
                requester: task.requester,
              }),
              { onNone: () => base.text, onSome: (result) => result.replyText },
            );
      const origin = task.originAddress;
      const deliveries = [
        replyDelivery({
          causeKey: "narration:" + pending.event.eventId + ":origin",
          destination: origin,
          kind: base.kind,
          text: worded,
          task,
          mentionActorId: mentionFor(origin, task.requester.externalActorId),
        }),
      ];
      // Work started elsewhere shows up in the bot as its chip and its final result only.
      const bot = (yield* ledger.getBot(stored.ownerId))?.bot;
      if (bot !== undefined && origin.kind !== "goat" && base.kind !== "question") {
        deliveries.push(
          replyDelivery({
            causeKey: "narration:" + pending.event.eventId + ":bot",
            destination: botAddress(bot),
            kind: base.kind,
            text: worded,
            task,
          }),
        );
      }
      yield* ledger.completeNarration({ owner, sequence: pending.sequence, deliveries, now });
      yield* wake.wake;
    });

  return ChannelReceptionService.of({ receive, narrate });
});

export const layer = Layer.effect(ChannelReceptionService, make);

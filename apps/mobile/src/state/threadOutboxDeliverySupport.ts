import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@goat/client-runtime/state/shell";
import {
  type AtomCommand,
  type AtomCommandResult,
  runAtomCommand,
} from "@goat/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type MessageId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { createDebugLogger } from "../lib/debugLog";
import { scopedThreadKey } from "../lib/scopedEntities";
import { prepareTurnAttachments, type PreparedTurnAttachments } from "../lib/attachmentUpload";
import {
  retainAcknowledgedThreadMessage,
  forgetAcknowledgedThreadMessage,
} from "./acknowledged-thread-messages";
import { appAtomRegistry } from "./atom-registry";
import { restoredNewTaskDraftKey } from "./new-task-draft-key";
import {
  pendingThreadCreationOutcomesAtom,
  recordPendingThreadCreationOutcome,
} from "./pending-thread-creation";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom } from "./server";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "./session";
import {
  confirmThreadOutboxMessageQueued,
  threadOutboxManager,
  threadOutboxRevision,
  updateThreadOutboxMessage,
} from "./thread-outbox";
import { removeThreadOutboxMessage } from "./thread-outbox-removal";
import {
  resolveThreadOutboxFailureAction,
  shouldRetryThreadOutboxDelivery,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
  type ThreadOutboxFailureAction,
} from "./thread-outbox-model";
import { environmentThreadShells } from "./threads";
import {
  appendComposerDraftAttachments,
  flushComposerDrafts,
  type ComposerDraft,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  replaceComposerDraftAttachments,
  removeDeliveredCloudQueuedMessage,
  undoComposerDraftMerge,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";
import {
  dispatchingQueuedMessageIdAtom,
  editingQueuedMessageIdsAtom,
  threadOutboxShellStatusesAtom,
} from "./use-thread-outbox";
import { clearThreadComposerError, setThreadComposerError } from "./thread-composer-error";
import { workspaceConnections } from "./workspace";

const threadOutboxDebug = createDebugLogger("thread-outbox");

function isRpcClientDecodeDefect(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("_tag" in error) ||
    error._tag !== "RpcClientError"
  ) {
    return false;
  }
  const reason: unknown = (error as { readonly reason?: unknown }).reason;
  return (
    typeof reason === "object" &&
    reason !== null &&
    "_tag" in reason &&
    reason._tag === "RpcClientDefect"
  );
}

function isOrdinaryThreadOutboxTransportFailure(error: unknown): boolean {
  return shouldRetryThreadOutboxDelivery(error) && !isRpcClientDecodeDefect(error);
}

function logThreadOutboxDeliveryFailure(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
  readonly context: Record<string, unknown>;
}): ThreadOutboxFailureAction {
  const action = resolveThreadOutboxFailureAction({
    stage: input.stage,
    error: input.error,
    interrupted: input.interrupted,
  });
  const details = { ...input.context, stage: input.stage, action };
  const ordinaryTransportRetry =
    action === "retry" &&
    !isRpcClientDecodeDefect(input.error) &&
    (input.interrupted ||
      input.stage !== "settings-sync" ||
      shouldRetryThreadOutboxDelivery(input.error));
  if (ordinaryTransportRetry) {
    threadOutboxDebug.log("queued message delivery failed", details);
  } else {
    console.warn("[thread-outbox] queued message delivery failed", details);
  }
  return action;
}

export function logThreadOutboxUploadFailure(
  queuedMessage: QueuedThreadMessage,
  error: unknown,
): void {
  const context = {
    environmentId: queuedMessage.environmentId,
    threadId: queuedMessage.threadId,
    messageId: queuedMessage.messageId,
  };
  if (isOrdinaryThreadOutboxTransportFailure(error)) {
    threadOutboxDebug.log("attachment upload failed; retrying", { ...context, error });
  } else {
    console.warn("[thread-outbox] failed to upload attachments", { ...context, error });
  }
}

export function beginDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, queuedMessageId);
}

export function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const current = appAtomRegistry.get(dispatchingQueuedMessageIdAtom);
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, current === queuedMessageId ? null : current);
}

export function findThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined {
  return threads.find(
    (candidate) =>
      candidate.environmentId === message.environmentId && candidate.id === message.threadId,
  );
}

export function findCreationProject(
  projects: ReadonlyArray<EnvironmentProject>,
  message: QueuedThreadMessage,
): EnvironmentProject | undefined {
  return projects.find(
    (candidate) =>
      candidate.environmentId === message.environmentId &&
      candidate.id === message.creation?.projectId,
  );
}

export function settingsCommandId(message: QueuedThreadMessage, setting: string): CommandId {
  return CommandId.make(`${message.commandId}:${setting}`);
}

export async function prepareQueuedMessageAttachments(
  queuedMessage: QueuedThreadMessage,
  supportsImageUploads = false,
): Promise<
  | {
      readonly status: "ready";
      readonly prepared: PreparedTurnAttachments;
      readonly persistedMessage: QueuedThreadMessage;
      readonly deliveryRevision: number;
    }
  | { readonly status: "abandoned" }
> {
  if (!(await confirmThreadOutboxMessageQueued(queuedMessage))) {
    return { status: "abandoned" };
  }
  if (!readEnvironmentScope(queuedMessage.environmentId, AuthOrchestrationOperateScope)) {
    return { status: "abandoned" };
  }
  const revision = threadOutboxRevision(queuedMessage.messageId);
  if (!isQueuedMessagePayloadCurrent(queuedMessage, revision)) {
    return { status: "abandoned" };
  }
  let persistedMessage = queuedMessage;
  let deliveryRevision = revision;
  const result = await prepareTurnAttachments({
    environmentId: queuedMessage.environmentId,
    attachments: queuedMessage.attachments,
    supportsImageUploads,
    persistUploadedReferences: async (draftAttachments) => {
      if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
        return "abandon";
      }
      const updatedMessage = { ...queuedMessage, attachments: draftAttachments };
      if (!(await updateThreadOutboxMessage(updatedMessage, revision))) {
        return "abandon";
      }
      persistedMessage = updatedMessage;
      deliveryRevision = revision + 1;
      return "persisted";
    },
  });
  if (
    result.status === "abandoned" ||
    !isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)
  ) {
    return { status: "abandoned" };
  }
  return { status: "ready", prepared: result, persistedMessage, deliveryRevision };
}

export function isQueuedMessagePayloadCurrent(
  message: QueuedThreadMessage,
  expectedRevision: number,
): boolean {
  return (
    threadOutboxRevision(message.messageId) === expectedRevision &&
    Object.values(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
      .flat()
      .some((candidate) => candidate === message)
  );
}

export async function completeQueuedMessageDelivery(
  queuedMessage: QueuedThreadMessage,
  deliveryRevision: number,
  sequence: number | undefined,
): Promise<"removed" | "edited" | "failed"> {
  clearThreadComposerError(
    scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId),
    queuedMessage.messageId,
  );
  try {
    await removeDeliveredCloudQueuedMessage(queuedMessage).catch((error) => {
      console.warn("[thread-outbox] could not update sign-out snapshot after delivery", {
        messageId: queuedMessage.messageId,
        error,
      });
    });
    // Editors can acquire entries during startTurn without bumping revisions; CAS alone would lose unsaved edits.
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      return "edited";
    }
    retainAcknowledgedThreadMessage(
      sequence === undefined ? queuedMessage : { ...queuedMessage, sequence },
    );
    const removed = await removeThreadOutboxMessage(
      queuedMessage,
      deliveryRevision,
      () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId],
    );
    if (!removed) {
      forgetAcknowledgedThreadMessage(queuedMessage);
      threadOutboxDebug.log("delivered message was edited before cleanup", {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
      });
      return "edited";
    }
    return "removed";
  } catch (error) {
    forgetAcknowledgedThreadMessage(queuedMessage);
    console.warn("[thread-outbox] failed to remove delivered queued message", {
      environmentId: queuedMessage.environmentId,
      threadId: queuedMessage.threadId,
      messageId: queuedMessage.messageId,
      error,
    });
    return "failed";
  }
}

export async function removeAcknowledgedExistingThreadMessage(
  queuedMessage: QueuedThreadMessage,
  acknowledgedMessageIds: Set<MessageId>,
): Promise<boolean> {
  try {
    await removeDeliveredCloudQueuedMessage(queuedMessage).catch((error) => {
      console.warn("[thread-outbox] could not update sign-out snapshot after delivery", {
        messageId: queuedMessage.messageId,
        error,
      });
    });
    const removed = await removeThreadOutboxMessage(queuedMessage);
    if (removed) {
      acknowledgedMessageIds.delete(queuedMessage.messageId);
    }
    return removed;
  } catch (error) {
    console.warn("[thread-outbox] failed to remove acknowledged queued message", {
      environmentId: queuedMessage.environmentId,
      threadId: queuedMessage.threadId,
      messageId: queuedMessage.messageId,
      error,
    });
    return false;
  }
}

export async function recoverEditedCreationAfterDelivery(
  queuedMessage: QueuedThreadMessage,
): Promise<boolean> {
  const kept = Object.values(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
    .flat()
    .find((candidate) => candidate.messageId === queuedMessage.messageId);
  if (!kept) {
    return true;
  }
  const keptRevision = threadOutboxRevision(kept.messageId);
  if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId]) {
    return true;
  }
  const draftKey = scopedThreadKey(kept.environmentId, kept.threadId);
  try {
    // Merge before removal to retain file ownership; allow overflow and let send guards require trimming.
    await mergeComposerDraftContent(draftKey, {
      text: kept.text,
      context: kept.context,
      attachments: [],
    });
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId]) {
      return true;
    }
    if (threadOutboxRevision(kept.messageId) !== keptRevision) {
      return false;
    }
    const existingAttachmentIds = new Set(
      getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id),
    );
    appendComposerDraftAttachments(
      draftKey,
      kept.attachments.filter((attachment) => !existingAttachmentIds.has(attachment.id)),
      { allowOverflow: true },
    );
    updateComposerDraftSettings(draftKey, {
      ...(kept.modelSelection !== undefined ? { modelSelection: kept.modelSelection } : {}),
      ...(kept.runtimeMode !== undefined ? { runtimeMode: kept.runtimeMode } : {}),
      ...(kept.interactionMode !== undefined ? { interactionMode: kept.interactionMode } : {}),
    });
    // Flush before removal: append only schedules persistence, leaving the queue as the sole durable copy.
    await flushComposerDrafts();
  } catch (error) {
    console.warn("[thread-outbox] could not hand an edited pending task to the composer", error);
    return false;
  }
  if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId]) {
    return true;
  }
  try {
    return await removeThreadOutboxMessage(
      kept,
      keptRevision,
      () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId],
    );
  } catch (error) {
    console.warn("[thread-outbox] could not remove recovered pending task", error);
    return false;
  }
}

export async function restoreRejectedQueuedMessage(
  queuedMessage: QueuedThreadMessage,
  message: string,
): Promise<"restored" | "deferred" | "blocked" | "retry"> {
  const draftKey = recoveryDraftKey(queuedMessage);
  const threadKey = scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId);
  let rollback: { readonly snapshot: ComposerDraft; readonly merged: ComposerDraft } | null = null;
  try {
    if (
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId] ||
      !(await confirmThreadOutboxMessageQueued(queuedMessage)) ||
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]
    ) {
      return "deferred";
    }
    const revision = threadOutboxRevision(queuedMessage.messageId);

    await waitForComposerDraftsLoaded();
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      return "deferred";
    }
    const originalDraft = getComposerDraftSnapshot(draftKey);
    const existingAttachmentIds = new Set(
      originalDraft.attachments.map((attachment) => attachment.id),
    );
    const addedAttachmentCount = queuedMessage.attachments.filter(
      (attachment) => !existingAttachmentIds.has(attachment.id),
    ).length;
    if (existingAttachmentIds.size + addedAttachmentCount > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      setThreadComposerError(
        threadKey,
        `Remove attachments from the draft before restoring this message. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
        queuedMessage.messageId,
      );
      return "blocked";
    }

    const withdrawError = () => clearThreadComposerError(threadKey, queuedMessage.messageId);
    if (!queuedMessage.creation) {
      setThreadComposerError(threadKey, message, queuedMessage.messageId);
    }
    let mergedDraft: ComposerDraft;
    try {
      stampRecoveryDraftProject(queuedMessage, draftKey);
      await mergeComposerDraftContent(draftKey, {
        text: queuedMessage.text,
        context: queuedMessage.context,
        attachments: queuedMessage.attachments,
      });
    } finally {
      // Capture rollback in finally because merge publishes even on persistence failure; undo must preserve concurrent edits.
      mergedDraft = getComposerDraftSnapshot(draftKey);
      rollback = { snapshot: originalDraft, merged: mergedDraft };
    }
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      withdrawError();
      await undoComposerDraftMerge(draftKey, originalDraft, mergedDraft);
      return "deferred";
    }
    updateComposerDraftSettings(draftKey, {
      ...(queuedMessage.modelSelection ? { modelSelection: queuedMessage.modelSelection } : {}),
      ...(queuedMessage.runtimeMode ? { runtimeMode: queuedMessage.runtimeMode } : {}),
      ...(queuedMessage.interactionMode ? { interactionMode: queuedMessage.interactionMode } : {}),
      ...(queuedMessage.creation
        ? {
            workspaceSelection: {
              mode: queuedMessage.creation.workspaceMode,
              branch: queuedMessage.creation.branch,
              worktreePath: queuedMessage.creation.worktreePath,
              pullRequestReference: queuedMessage.creation.pullRequestReference,
              ...(queuedMessage.creation.startFromOrigin !== undefined
                ? { startFromOrigin: queuedMessage.creation.startFromOrigin }
                : {}),
            },
          }
        : {}),
    });
    const restoredDraft = getComposerDraftSnapshot(draftKey);
    rollback = { snapshot: originalDraft, merged: restoredDraft };
    await flushComposerDrafts();
    if (
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId] ||
      !(await confirmThreadOutboxMessageQueued(queuedMessage)) ||
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]
    ) {
      withdrawError();
      await undoComposerDraftMerge(draftKey, originalDraft, restoredDraft);
      return "deferred";
    }
    if (
      !(await removeThreadOutboxMessage(
        queuedMessage,
        revision,
        () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId],
      ))
    ) {
      withdrawError();
      await undoComposerDraftMerge(draftKey, originalDraft, restoredDraft);
      return "deferred";
    }
    // After queue removal, the draft owns content and must never roll back.
    rollback = null;
    if (queuedMessage.creation) {
      withdrawError();
      recordPendingThreadCreationOutcome({
        kind: "failed",
        message: queuedMessage,
        reason: message,
      });
    }
    return "restored";
  } catch (error) {
    if (rollback !== null) {
      await undoComposerDraftMerge(draftKey, rollback.snapshot, rollback.merged).catch(
        (undoError) => {
          console.warn("[thread-outbox] failed to persist a recovery rollback", undoError);
        },
      );
    }
    console.warn("[thread-outbox] failed to restore an undeliverable message", error);
    setThreadComposerError(
      threadKey,
      error instanceof Error ? error.message : "The unsent message could not be restored.",
      queuedMessage.messageId,
    );
    return "retry";
  }
}

/** Derive keys from message ids so failed recovery retries reuse the same draft. */
export function recoveryDraftKey(queuedMessage: QueuedThreadMessage): string {
  return queuedMessage.creation
    ? restoredNewTaskDraftKey(queuedMessage.messageId)
    : scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId);
}

function stampRecoveryDraftProject(queuedMessage: QueuedThreadMessage, draftKey: string): void {
  if (!queuedMessage.creation) {
    return;
  }
  updateComposerDraftSettings(draftKey, {
    project: {
      environmentId: queuedMessage.environmentId,
      projectId: queuedMessage.creation.projectId,
      createdAt: queuedMessage.createdAt,
    },
  });
}

export async function preserveUploadedAttachmentsForEditor(
  originalMessage: QueuedThreadMessage,
  uploadedMessage: QueuedThreadMessage,
): Promise<void> {
  if (!originalMessage.creation) {
    return;
  }

  const draftKey = `pending-task:${originalMessage.messageId}`;
  const draft = getComposerDraftSnapshot(draftKey);
  const uploadedById = new Map(
    uploadedMessage.attachments.map((attachment) => [attachment.id, attachment] as const),
  );
  let changed = false;
  const nextAttachments = draft.attachments.map((attachment) => {
    const uploaded = uploadedById.get(attachment.id);
    if (
      !uploaded?.uploadedAttachmentId ||
      uploaded.uploadEnvironmentId !== originalMessage.environmentId ||
      (attachment.uploadedAttachmentId === uploaded.uploadedAttachmentId &&
        attachment.uploadEnvironmentId === uploaded.uploadEnvironmentId)
    ) {
      return attachment;
    }
    changed = true;
    return {
      ...attachment,
      uploadedAttachmentId: uploaded.uploadedAttachmentId,
      uploadEnvironmentId: uploaded.uploadEnvironmentId,
    };
  });
  if (changed) {
    replaceComposerDraftAttachments(draftKey, nextAttachments);
    await flushComposerDrafts();
  }
}

// Everything a drain pass decides from. Each queued environment's session is
// read here so a granted or revoked operate scope re-runs the drain.
export const deliveryInputsAtom = Atom.make((get) => {
  const connectedEnvironments = get(workspaceConnections.environmentsAtom);
  const operableEnvironments = new Set<EnvironmentId>();
  for (const { environmentId } of connectedEnvironments) {
    if (
      sessionHasScope(
        get(environmentSession.sessionStateAtom(environmentId)),
        AuthOrchestrationOperateScope,
      )
    ) {
      operableEnvironments.add(environmentId);
    }
  }
  return {
    dispatchingQueuedMessageId: get(dispatchingQueuedMessageIdAtom),
    editingQueuedMessageIds: get(editingQueuedMessageIdsAtom),
    queuedMessagesByThreadKey: get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
    shellStatuses: get(threadOutboxShellStatusesAtom),
    threads: get(environmentThreadShells.threadShellsAtom),
    projects: get(environmentProjects.projectsAtom),
    serverConfigs: get(environmentServerConfigsAtom),
    connectedEnvironments,
    operableEnvironments,
  };
}).pipe(Atom.withLabel("mobile:thread-outbox:delivery-inputs"));

// Read through the shell atom, not once: the shell often lands before the
// outcome is recorded, and that entry must still be collected when it does.
export const settledCreationOutcomeKeysAtom = Atom.make((get): ReadonlyArray<string> => {
  const outcomes = get(pendingThreadCreationOutcomesAtom);
  const threads = get(environmentThreadShells.threadShellsAtom);
  return Object.entries(outcomes).flatMap(([threadKey, outcome]) =>
    outcome.kind === "delivered" &&
    threads.some(
      (thread) =>
        scopedThreadKey(thread.environmentId, thread.id) === threadKey &&
        (thread.latestRun !== null ||
          thread.runtime?.status === "failed" ||
          thread.runtime?.status === "cancelled" ||
          thread.runtime?.status === "interrupted"),
    )
      ? [threadKey]
      : [],
  );
}).pipe(Atom.withLabel("mobile:thread-outbox:settled-creation-outcomes"));

export const runDeliveryCommand = <W, A, E>(
  command: AtomCommand<W, A, E>,
  input: W,
): Promise<AtomCommandResult<A, E>> =>
  runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });

export function reportCommandFailure(
  queuedMessage: QueuedThreadMessage,
  commandResult: AtomCommandResult<unknown, unknown>,
  stage: ThreadOutboxCommandStage,
): { readonly action: "retry" | "restore"; readonly message: string } | null {
  if (!AsyncResult.isFailure(commandResult)) {
    return null;
  }
  const error = Cause.squash(commandResult.cause);
  const action = logThreadOutboxDeliveryFailure({
    stage,
    error,
    interrupted: Cause.hasInterruptsOnly(commandResult.cause),
    context: {
      environmentId: queuedMessage.environmentId,
      threadId: queuedMessage.threadId,
      messageId: queuedMessage.messageId,
      cause: commandResult.cause,
    },
  });
  return {
    action,
    message: error instanceof Error ? error.message : "The message could not be sent.",
  };
}

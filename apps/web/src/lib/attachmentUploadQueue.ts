import {
  AuthOrchestrationOperateScope,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  type ChatAttachment,
  type EnvironmentId,
} from "@goat/contracts";
import { parseScopedThreadKey } from "@goat/client-runtime/environment";
import { createAttachmentUploadRegistry } from "@goat/client-runtime/state/attachmentUploadRegistry";
import { resolveAssetUrl } from "@goat/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
  verifyPersistedAttachmentUpload,
  type PersistedAttachmentVerification,
} from "@goat/client-runtime/state/attachments";
import { create } from "zustand";
import * as Option from "effect/Option";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/reactivity";

import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentCatalog } from "../connection/catalog";
import { assetEnvironment } from "../state/assets";
import { attachmentEnvironment } from "../state/attachments";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import {
  attachmentUploadForEnvironment,
  type AttachmentUploadState,
  type ReadyAttachmentUpload,
} from "./attachmentUploadState";

const MAX_UPLOADS_PER_ENVIRONMENT = 3;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

interface AttachmentUploadStore {
  readonly uploadsByImageId: Readonly<Record<string, AttachmentUploadState>>;
}

export const useAttachmentUploadStore = create<AttachmentUploadStore>(() => ({
  uploadsByImageId: {},
}));

interface UploadJob {
  readonly image: ComposerImageAttachment | ComposerFileAttachment;
  readonly environmentId: EnvironmentId;
  /** Original owner; completion resolves the current owner because uploads can outlive draft moves. */
  readonly draftTarget?: ComposerThreadTarget;
  readonly previous?: ReadyAttachmentUpload;
  /** Draft-owned; delete only through releasePersistedAttachmentUpload, never queue cancel/retry. */
  readonly persistedAttachmentId?: string;
  readonly settled: Promise<WebUploadError | undefined>;
  resolveSettled: (error?: WebUploadError) => void;
  attachmentId: string | null;
  cancelled: boolean;
  abort: (() => void) | null;
  stopWatchingConnection: () => void;
  release: () => void;
  waiters: number;
  draftReleased: boolean;
}

type DraftFileOwner = Pick<UploadJob, "image" | "environmentId" | "draftTarget">;

const heldUploadsByImageId = new Map<string, UploadJob>();

function setUploadState(imageId: string, upload: AttachmentUploadState): void {
  useAttachmentUploadStore.setState((state) => ({
    uploadsByImageId: { ...state.uploadsByImageId, [imageId]: upload },
  }));
}

function setJobUploadState(job: UploadJob, upload: AttachmentUploadState): void {
  if (heldUploadsByImageId.get(job.image.id) === job) setUploadState(job.image.id, upload);
}

function clearUploadState(imageId: string): void {
  useAttachmentUploadStore.setState((state) => {
    if (!(imageId in state.uploadsByImageId)) {
      return state;
    }
    const uploadsByImageId = { ...state.uploadsByImageId };
    delete uploadsByImageId[imageId];
    return { uploadsByImageId };
  });
}

export function readAttachmentUpload(
  imageId: string,
  environmentId?: EnvironmentId,
): AttachmentUploadState | undefined {
  const upload = useAttachmentUploadStore.getState().uploadsByImageId[imageId];
  return environmentId === undefined
    ? upload
    : attachmentUploadForEnvironment(upload, environmentId);
}

function resolveCurrentFileDraftTarget(job: DraftFileOwner): ComposerThreadTarget | undefined {
  if (job.draftTarget === undefined || job.image.type !== "file") {
    return undefined;
  }
  const store = useComposerDraftStore.getState();
  for (const [key, draft] of Object.entries(store.draftsByThreadKey)) {
    if (!draft.files.some((file) => file.id === job.image.id)) {
      continue;
    }
    const draftSession = store.draftThreadsByThreadKey[key];
    if (draftSession !== undefined) {
      if (draftSession.environmentId === job.environmentId) {
        return DraftId.make(key);
      }
      continue;
    }
    if (typeof job.draftTarget === "string" && job.draftTarget === key) {
      return DraftId.make(key);
    }
    const threadRef = parseScopedThreadKey(key);
    if (threadRef?.environmentId === job.environmentId) {
      return threadRef;
    }
  }
  return undefined;
}

/** Persist background completions even when no composer is mounted. */
function stampDraftFileUpload(job: DraftFileOwner, attachmentId: string): void {
  const draftTarget = resolveCurrentFileDraftTarget(job);
  if (draftTarget === undefined) {
    return;
  }
  useComposerDraftStore
    .getState()
    .setFileUpload(draftTarget, job.image.id, job.environmentId, attachmentId);
}

function deletePendingUpload(environmentId: EnvironmentId, attachmentId: string): void {
  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
  void deletePendingAttachmentUpload({
    registry: appAtomRegistry,
    remove: attachmentEnvironment.remove,
    environmentId,
    attachmentId,
  }).then((result) => {
    if (!result.ok)
      console.warn("[attachments] could not delete pending upload", {
        attachmentId,
        error: result.error,
      });
  });
}

export function uploadBytes(input: {
  readonly url: string;
  readonly file: File;
  readonly mimeType: string;
  readonly onProgress: (progress: number) => void;
}): { readonly done: Promise<void>; readonly abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    xhr.open("POST", input.url, true);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", input.mimeType);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        input.onProgress(event.loaded / event.total);
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload rejected (${xhr.status})`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("timeout", () => reject(new Error("Upload timed out")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
    xhr.send(input.file);
  });

  return { done, abort: () => xhr.abort() };
}

async function runUpload(job: UploadJob): Promise<void> {
  if (!readEnvironmentScope(job.environmentId, AuthOrchestrationOperateScope)) {
    setJobUploadState(job, {
      status: "failed",
      environmentId: job.environmentId,
      reason: "This connection cannot upload attachments.",
      ...(job.previous ? { previous: job.previous } : {}),
    });
    return;
  }
  if (job.persistedAttachmentId) {
    const verification = await verifyPersistedAttachmentUpload({
      registry: appAtomRegistry,
      createAssetUrl: assetEnvironment.createUrl,
      environmentId: job.environmentId,
      attachmentId: job.persistedAttachmentId,
    });
    if (job.cancelled) {
      return;
    }
    if (verification.status === "verified") {
      setJobUploadState(job, {
        status: "ready",
        environmentId: job.environmentId,
        attachmentId: job.persistedAttachmentId,
      });
      stampDraftFileUpload(job, job.persistedAttachmentId);
      return;
    }
    if (verification.status === "missing" && !job.image.file && job.image.type === "file") {
      const draftTarget = resolveCurrentFileDraftTarget(job);
      if (
        draftTarget !== undefined &&
        useComposerDraftStore
          .getState()
          .markFileUploadMissing(
            draftTarget,
            job.image.id,
            job.environmentId,
            job.persistedAttachmentId,
          )
      ) {
        if (heldUploadsByImageId.get(job.image.id) === job) clearUploadState(job.image.id);
        return;
      }
    }
    if (verification.status === "failed" || !job.image.file) {
      // Failed-state ids get deleted on retry/release; exclude persisted ids after transient verification failure.
      setJobUploadState(job, {
        status: "failed",
        environmentId: job.environmentId,
        reason:
          verification.status === "missing"
            ? "Uploaded file expired. Remove it and attach it again."
            : "Uploaded file could not be verified. Retry when the server reconnects.",
        ...(job.previous ? { previous: job.previous } : {}),
      });
      return;
    }
  }

  const mimeType =
    job.image.type === "file"
      ? job.image.mimeType.toLowerCase()
      : PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find(
          (supportedMimeType) => supportedMimeType === job.image.mimeType.toLowerCase(),
        );
  if (!mimeType) {
    setJobUploadState(job, {
      status: "failed",
      environmentId: job.environmentId,
      reason: "Unsupported image type",
      ...(job.previous ? { previous: job.previous } : {}),
    });
    return;
  }
  const file = job.image.file;
  if (!file) {
    setJobUploadState(job, {
      status: "failed",
      environmentId: job.environmentId,
      reason: "Original file is no longer available",
      ...(job.previous ? { previous: job.previous } : {}),
    });
    return;
  }

  let lastStep = -1;
  if (!readEnvironmentScope(job.environmentId, AuthOrchestrationOperateScope)) {
    setJobUploadState(job, {
      status: "failed",
      environmentId: job.environmentId,
      reason: "This connection cannot upload attachments.",
      ...(job.previous ? { previous: job.previous } : {}),
    });
    return;
  }
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId: job.environmentId,
    upload: {
      ...(job.image.type === "file" ? { type: "file" as const } : {}),
      name: job.image.name,
      mimeType,
      sizeBytes: file.size,
    },
    resolveUploadUrl: (relativeUrl) => {
      if (
        job.cancelled ||
        !readEnvironmentScope(job.environmentId, AuthOrchestrationOperateScope)
      ) {
        return null;
      }
      const connection = readPreparedConnection(job.environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) =>
      uploadBytes({
        url,
        file,
        mimeType,
        onProgress: (progress) => {
          const step = Math.floor(progress * 20);
          if (step === lastStep || job.cancelled) {
            return;
          }
          lastStep = step;
          setJobUploadState(job, {
            status: "uploading",
            environmentId: job.environmentId,
            progress,
            ...(job.previous ? { previous: job.previous } : {}),
          });
        },
      }),
    onMinted: (attachmentId) => {
      if (job.cancelled && readEnvironmentScope(job.environmentId, AuthOrchestrationOperateScope)) {
        return "cancel";
      }
      job.attachmentId = attachmentId;
      return "continue";
    },
    onTransferStart: (abort) => {
      job.abort = abort;
    },
  });
  job.abort = null;
  if (result.status === "cancelled" || job.cancelled) {
    if (result.status === "cancelled" && result.cleanupFailure !== undefined) {
      console.warn("[attachments] could not delete cancelled upload", {
        attachmentId: result.attachmentId,
        error: result.cleanupFailure.error,
      });
    }
    return;
  }
  if (result.status === "uploaded") {
    if (heldUploadsByImageId.get(job.image.id) !== job) {
      deletePendingUpload(job.environmentId, result.attachmentId);
      return;
    }
    setJobUploadState(job, {
      status: "ready",
      environmentId: job.environmentId,
      attachmentId: result.attachmentId,
    });
    stampDraftFileUpload(job, result.attachmentId);
    if (job.previous) {
      deletePendingUpload(job.previous.environmentId, job.previous.attachmentId);
    }
    return;
  }
  setJobUploadState(job, {
    status: "failed",
    environmentId: job.environmentId,
    reason:
      result.step === "mint"
        ? "Upload could not start"
        : result.step === "resolve-url"
          ? readEnvironmentScope(job.environmentId, AuthOrchestrationOperateScope)
            ? "Not connected"
            : "This connection cannot upload attachments."
          : result.error instanceof Error
            ? result.error.message
            : "Upload failed",
    ...(result.attachmentId ? { attachmentId: result.attachmentId } : {}),
    ...(job.previous ? { previous: job.previous } : {}),
  });
}

class WebUploadError extends Data.TaggedError("WebUploadError")<{ readonly message: string }> {}

const uploadKey = (job: UploadJob) => JSON.stringify([job.environmentId, job.image.id]);
const registry = createAttachmentUploadRegistry<UploadJob, WebUploadError>({
  key: uploadKey,
  concurrency: {
    type: "per-environment",
    limit: MAX_UPLOADS_PER_ENVIRONMENT,
    environment: (job) => job.environmentId,
  },
  error: (cause) =>
    new WebUploadError({ message: cause instanceof Error ? cause.message : "Upload failed" }),
  onChange: () => {},
  upload: async (job, signal) => {
    const abort = () => {
      job.cancelled = true;
      job.abort?.();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      await runUpload(job);
      const state = readAttachmentUpload(job.image.id);
      if (job.cancelled || state?.status !== "ready" || state.environmentId !== job.environmentId) {
        throw new Error(state?.status === "failed" ? state.reason : "Upload cancelled");
      }
      return state.attachmentId;
    } catch (error) {
      if (
        !job.cancelled &&
        heldUploadsByImageId.get(job.image.id) === job &&
        readAttachmentUpload(job.image.id)?.status === "uploading"
      ) {
        setJobUploadState(job, {
          status: "failed",
          environmentId: job.environmentId,
          reason: "Upload failed",
          ...(job.previous ? { previous: job.previous } : {}),
        });
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      if (
        heldUploadsByImageId.get(job.image.id) === job &&
        readAttachmentUpload(job.image.id)?.status !== "failed"
      ) {
        job.stopWatchingConnection();
        heldUploadsByImageId.delete(job.image.id);
        job.release();
      }
      job.resolveSettled();
    }
  },
});

export function startAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly image: ComposerImageAttachment | ComposerFileAttachment;
  readonly draftTarget?: ComposerThreadTarget;
}): void {
  if (!readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)) return;
  const existingJob = heldUploadsByImageId.get(input.image.id);
  if (existingJob?.environmentId === input.environmentId) {
    return;
  }

  const existing = readAttachmentUpload(input.image.id);
  if (existing?.status === "ready" && existing.environmentId === input.environmentId) {
    // A file restored into a draft after its upload finished (stash, failed send) missed the
    // completion stamp; stamping here keeps it from re-uploading after a reload.
    stampDraftFileUpload(input, existing.attachmentId);
    return;
  }
  if (existing?.status === "failed" && existing.environmentId === input.environmentId) {
    return;
  }
  if (
    existing &&
    "previous" in existing &&
    existing.previous?.environmentId === input.environmentId
  ) {
    cancelAttachmentUpload(input.image.id);
    if (existing.status === "failed" && existing.attachmentId) {
      deletePendingUpload(existing.environmentId, existing.attachmentId);
    }
    setUploadState(input.image.id, existing.previous);
    // Retargeting a scratch draft cleared the file's upload stamp; restore it for reloads.
    stampDraftFileUpload(input, existing.previous.attachmentId);
    return;
  }

  if (existingJob) {
    cancelAttachmentUpload(input.image.id);
  }
  const previous = existing?.status === "ready" ? existing : existing?.previous;
  let resolveSettled: (error?: WebUploadError) => void = () => {};
  const settled = new Promise<WebUploadError | undefined>((resolve) => {
    resolveSettled = (error) => resolve(error);
  });
  const job: UploadJob = {
    image: input.image,
    environmentId: input.environmentId,
    ...(input.draftTarget !== undefined ? { draftTarget: input.draftTarget } : {}),
    ...(previous ? { previous } : {}),
    ...(input.image.type === "file" &&
    input.image.uploadEnvironmentId === input.environmentId &&
    input.image.uploadedAttachmentId
      ? { persistedAttachmentId: input.image.uploadedAttachmentId }
      : {}),
    settled,
    resolveSettled,
    attachmentId: null,
    cancelled: false,
    abort: null,
    stopWatchingConnection: () => {},
    release: () => {},
    waiters: 0,
    draftReleased: false,
  };

  heldUploadsByImageId.set(input.image.id, job);
  const connectionAtom = environmentCatalog.stateAtom(job.environmentId);
  const isConnected = () =>
    Option.exists(
      AsyncResult.value(appAtomRegistry.get(connectionAtom)),
      (state) => state.phase === "connected",
    );
  let wasConnected = isConnected();
  job.stopWatchingConnection = appAtomRegistry.subscribe(connectionAtom, () => {
    const connected = isConnected();
    const reconnected = connected && !wasConnected;
    wasConnected = connected;
    if (!reconnected) return;
    // HTTP failures can follow reconnection; await the attempt and retry only if this job still owns the file.
    void job.settled.then(() => {
      if (
        heldUploadsByImageId.get(job.image.id) === job &&
        readAttachmentUpload(job.image.id)?.status === "failed" &&
        isConnected()
      ) {
        retryAttachmentUpload(input);
      }
    });
  });
  setUploadState(input.image.id, {
    status: "uploading",
    environmentId: input.environmentId,
    progress: 0,
    ...(previous ? { previous } : {}),
  });
  try {
    job.release = registry.hold(job);
  } catch (cause) {
    const error = new WebUploadError({
      message: cause instanceof Error ? cause.message : "Upload failed",
    });
    job.stopWatchingConnection();
    job.resolveSettled(error);
    if (heldUploadsByImageId.get(input.image.id) === job) {
      heldUploadsByImageId.delete(input.image.id);
      setUploadState(input.image.id, {
        status: "failed",
        environmentId: input.environmentId,
        reason: error.message,
        ...(previous ? { previous } : {}),
      });
    }
  }
}

function cancelAttachmentUpload(imageId: string): void {
  const job = heldUploadsByImageId.get(imageId);
  if (!job) {
    return;
  }
  if (job.waiters > 0) {
    job.draftReleased = true;
    return;
  }
  job.release();
  job.release = () => {};
  job.cancelled = true;
  job.stopWatchingConnection();
  heldUploadsByImageId.delete(imageId);
  if (job.attachmentId) deletePendingUpload(job.environmentId, job.attachmentId);
  job.resolveSettled();
}

export function releaseAttachmentUpload(imageId: string, environmentId?: EnvironmentId): void {
  const upload = readAttachmentUpload(imageId);
  const job = heldUploadsByImageId.get(imageId);
  if (
    environmentId !== undefined &&
    (job?.environmentId ?? upload?.environmentId) !== environmentId
  )
    return;
  const hasWaiters = (heldUploadsByImageId.get(imageId)?.waiters ?? 0) > 0;
  cancelAttachmentUpload(imageId);
  if (hasWaiters) return;
  if (upload?.status === "ready") {
    deletePendingUpload(upload.environmentId, upload.attachmentId);
  } else if (upload) {
    if (upload.status === "failed" && upload.attachmentId) {
      deletePendingUpload(upload.environmentId, upload.attachmentId);
    }
    if (upload.previous) {
      deletePendingUpload(upload.previous.environmentId, upload.previous.attachmentId);
    }
  }
  clearUploadState(imageId);
}

export function releasePersistedAttachmentUpload(input: {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
}): void {
  const upload = readAttachmentUpload(input.id);
  if (
    upload?.status === "ready" &&
    upload.environmentId === input.environmentId &&
    upload.attachmentId === input.attachmentId
  ) {
    releaseAttachmentUpload(input.id, input.environmentId);
    return;
  }
  const job = heldUploadsByImageId.get(input.id);
  if (
    job?.environmentId === input.environmentId &&
    job.persistedAttachmentId === input.attachmentId
  ) {
    releaseAttachmentUpload(input.id, input.environmentId);
  }
  deletePendingUpload(input.environmentId, input.attachmentId);
}

export function retryAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly image: ComposerImageAttachment | ComposerFileAttachment;
  readonly draftTarget?: ComposerThreadTarget;
}): void {
  if (!readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)) return;
  const previous = readAttachmentUpload(input.image.id);
  cancelAttachmentUpload(input.image.id);
  if (previous?.status === "failed" && previous.attachmentId) {
    deletePendingUpload(previous.environmentId, previous.attachmentId);
  }
  if (previous && "previous" in previous && previous.previous) {
    setUploadState(input.image.id, previous.previous);
  } else {
    clearUploadState(input.image.id);
  }
  startAttachmentUpload(input);
}

/** Verifies uploads before stash restore; pending uploads expire after 24 hours. */
export function verifyStashedAttachmentUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
}): Promise<PersistedAttachmentVerification> {
  return verifyPersistedAttachmentUpload({
    registry: appAtomRegistry,
    createAssetUrl: assetEnvironment.createUrl,
    environmentId: input.environmentId,
    attachmentId: input.attachmentId,
  });
}

export async function awaitAttachmentUploads(
  imageIds: ReadonlyArray<string>,
  environmentId?: EnvironmentId,
): Promise<void> {
  await Promise.all(
    imageIds.map(async (imageId) => {
      const job = heldUploadsByImageId.get(imageId);
      if (!job || (environmentId !== undefined && job.environmentId !== environmentId)) return;
      job.waiters++;
      try {
        const error = await job.settled;
        if (error) throw error;
      } finally {
        job.waiters--;
        if (job.draftReleased && job.waiters === 0) {
          job.release();
          job.release = () => {};
        }
      }
    }),
  );
}

export function getUploadedAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly images: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
}): ChatAttachment[] | null {
  const attachments: ChatAttachment[] = [];
  for (const image of input.images) {
    const upload = readAttachmentUpload(image.id);
    if (upload?.status !== "ready" || upload.environmentId !== input.environmentId) {
      return null;
    }
    attachments.push({
      type: image.type,
      id: upload.attachmentId,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      ...(image.source ? { source: image.source } : {}),
    });
  }
  return attachments;
}

/** In-memory queue releases miss uploads after reload; every draft discard must use this path. */
export function releaseDraftAttachment(
  attachment: ComposerImageAttachment | ComposerFileAttachment,
  environmentId?: EnvironmentId,
): void {
  if (
    attachment.type === "file" &&
    attachment.uploadedAttachmentId !== undefined &&
    attachment.uploadEnvironmentId !== undefined
  ) {
    if (environmentId !== undefined && environmentId !== attachment.uploadEnvironmentId) {
      releaseAttachmentUpload(attachment.id, environmentId);
      return;
    }
    releasePersistedAttachmentUpload({
      id: attachment.id,
      environmentId: attachment.uploadEnvironmentId,
      attachmentId: attachment.uploadedAttachmentId,
    });
    if (heldUploadsByImageId.has(attachment.id) || readAttachmentUpload(attachment.id)) {
      releaseAttachmentUpload(attachment.id, environmentId ?? attachment.uploadEnvironmentId);
    }
    return;
  }
  releaseAttachmentUpload(attachment.id, environmentId);
}

export function releaseDraftAttachments(
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
  environmentId?: EnvironmentId,
): void {
  for (const attachment of attachments) {
    releaseDraftAttachment(attachment, environmentId);
  }
}

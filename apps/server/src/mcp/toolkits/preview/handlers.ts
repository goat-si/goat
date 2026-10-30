import { classifyBrowserActionOutcome } from "../../../preview/actionOutcomeSafety.ts";
import { failureHint, previewHints } from "./hints.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  OrchestratorMcpFailure,
  PREVIEW_RECORDING_STOP_TIMEOUT_MS,
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingArtifact,
  type ActionOutcomeSafety,
  type ToolActivityIcon,
  type ThreadId,
  type PreviewAutomationOperation,
  type PreviewAutomationOpenInput,
  type PreviewAutomationRecordingStatus,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSelectResult,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationFetchResult,
  type PreviewAutomationRead,
  type PreviewAutomationFillSecretResult,
  type PreviewAutomationScrollCollectResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationLogs,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@goat/contracts";

import {
  parseAttachmentUuid,
  parseAttachmentFileExtension,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  toSafeThreadAttachmentSegment,
} from "../../../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../../../attachmentPaths.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { browserGuideFor } from "../../../preview/BrowserGuide.ts";
import * as SiteNotes from "../../../preview/SiteNotes.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

const requireSiteNotes = Effect.serviceOption(SiteNotes.SiteNotes).pipe(
  Effect.flatMap((notes) => Option.isSome(notes) ? Effect.succeed(notes.value) : Effect.fail(new OrchestratorMcpFailure({ code: "orchestration_error", message: "Site notes are unavailable." }))),
);

/** Whether a preview the agent
 * said nothing about surfaces is the user's `browserAutoShowFloatingPreview`
 * preference, which is desktop-local and unreadable from here — filling in
 * `true` would silently override it for every `preview_open`.
 */
function normalizePreviewOpenInput(input: PreviewAutomationOpenInput): PreviewAutomationOpenInput {
  const open = input.open ?? input.show;
  return {
    ...input,
    ...(open === undefined ? {} : { open, show: open }),
    reuseExistingTab: input.reuseExistingTab ?? true,
  };
}

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
  tabId?: PreviewTabId,
): Effect.fn.Return<
  { result: A; safety?: ActionOutcomeSafety; toolIcon?: ToolActivityIcon },
  import("@goat/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  let targetTabId = tabId;
  const result = yield* broker
    .invoke<A>({
      onTargetTab: (resolvedTabId) => {
        targetTabId = resolvedTabId;
      },
      scope,
      operation,
      input,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(tabId === undefined ? {} : { tabId }),
    })
    .pipe(
      Effect.mapError((error) => {
        const safety = classifyBrowserActionOutcome({
          operation,
          status: "failed",
          errorTag: error._tag,
          ...(error._tag === "PreviewAutomationControlInterruptedError"
            ? { controlReason: error.reason }
            : {}),
          ...("dispatched" in error && error.dispatched !== undefined
            ? { dispatched: error.dispatched }
            : {}),
        });
        return Object.assign(error, { safety, ...failureHint(operation, error, safety) });
      }),
    );
  const completed = classifyBrowserActionOutcome({ operation, status: "completed" });
  // A finished read says nothing an agent can act on, so only writes carry their safety.
  const safety = completed.writeStatus === "not_applicable" ? {} : { safety: completed };
  if (
    [
      "status",
      "open",
      "navigate",
      "back",
      "forward",
      "reload",
      "snapshot",
      "logs",
      "fetch",
      "read",
      "fillSecret",
    ].includes(operation)
  )
    return { result, ...safety };
  // A result that names its page's URL already says where the tab is.
  const resultUrl =
    operation === "click" && typeof result === "object" && result !== null && "url" in result
      ? result.url
      : undefined;
  if (typeof resultUrl === "string") {
    const { url: _url, ...rest } = result as { readonly url: string };
    return {
      result: rest as A,
      ...safety,
      ...(/^https?:\/\//i.test(resultUrl) && resultUrl.length <= 4096
        ? { toolIcon: { _tag: "website" as const, pageUrl: resultUrl } }
        : {}),
    };
  }
  const statusTabId =
    (operation !== "evaluate" && typeof result === "object" && result !== null
      ? (result as { tabId?: PreviewTabId }).tabId
      : undefined) ?? targetTabId;
  const page = yield* broker
    .invoke<PreviewAutomationStatus>({
      scope,
      operation: "status",
      input: {},
      timeoutMs: 500,
      updateCurrentTab: false,
      ...(statusTabId === undefined ? {} : { tabId: statusTabId }),
    })
    .pipe(Effect.orElseSucceed(() => null));
  return {
    result,
    ...safety,
    ...(page?.url && /^https?:\/\//i.test(page.url) && page.url.length <= 4096
      ? { toolIcon: { _tag: "website" as const, pageUrl: page.url } }
      : {}),
  };
});

const GUIDED = new Set<PreviewAutomationOperation>(["open", "navigate", "read"]);

/** The browser skill's path and the page's site notes, the first time this thread meets each. */
const browserGuide = Effect.fn("PreviewToolkit.browserGuide")(function* (
  operation: PreviewAutomationOperation,
  result: object,
) {
  if (!GUIDED.has(operation)) return {};
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (invocation.thread === undefined) return {};
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const notes = yield* requireSiteNotes;
  const guide = browserGuideFor(
    config._tag === "Some" ? config.value.stateDir : undefined,
    invocation.thread.threadId,
    "url" in result && typeof result.url === "string" ? result.url : undefined,
    notes.deliverOnce,
  );
  return guide === undefined ? {} : { guide };
});

const invokeTargeted = <A extends object>(
  operation: PreviewAutomationOperation,
  input: {
    readonly tabId?: PreviewTabId | undefined;
    readonly [key: string]: unknown;
  },
  timeoutMs?: number,
) => {
  const { tabId, ...operationInput } = input;
  return invoke<A>(operation, operationInput, timeoutMs, tabId).pipe(
    Effect.flatMap(({ result, toolIcon, safety }) =>
      browserGuide(operation, result).pipe(
        Effect.map((guide) => ({
          ...result,
          ...(safety === undefined ? {} : { safety }),
          ...(toolIcon ? { toolIcon } : {}),
          ...previewHints(operation, result),
          ...guide,
        })),
      ),
    ),
  );
};

const UploadedRecordingArtifact = Schema.Struct({
  ...PreviewAutomationRecordingArtifact.fields,
  uploadedAttachmentId: Schema.optional(Schema.String),
});
const decodeUploadedRecordingArtifact = Schema.decodeUnknownEffect(UploadedRecordingArtifact);

export const claimPreviewRecording = Effect.fn("PreviewToolkit.claimRecording")(function* (
  threadId: ThreadId,
  response: unknown,
) {
  const artifact = yield* decodeUploadedRecordingArtifact(response).pipe(
    Effect.mapError(
      (cause) =>
        new PreviewAutomationRecordingTransferError({
          threadId,
          cause,
        }),
    ),
  );
  if (!artifact.uploadedAttachmentId) {
    return yield* new PreviewAutomationRecordingDesktopUpdateRequiredError({ threadId });
  }
  const config = yield* ServerConfig.ServerConfig;
  const uuid = parseAttachmentUuid(artifact.uploadedAttachmentId);
  const extension = parseAttachmentFileExtension(artifact.uploadedAttachmentId);
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  const pendingId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${uuid}-${extension}`;
  if (!uuid || !extension || !threadSegment || artifact.uploadedAttachmentId !== pendingId) {
    return yield* new PreviewAutomationRecordingTransferError({
      threadId,
    });
  }
  const finalId = `${threadSegment}-${uuid}-${extension}`;
  const currentPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${pendingId}.${extension}`,
  });
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${finalId}.${extension}`,
  });
  if (!currentPath || !finalPath) {
    return yield* new PreviewAutomationRecordingTransferError({ threadId });
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const validateFile = (filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.filterOrFail(
        (stat) =>
          stat.type === "File" &&
          Number(stat.size) === artifact.sizeBytes &&
          artifact.sizeBytes > 0 &&
          artifact.sizeBytes <= PROVIDER_SEND_TURN_MAX_FILE_BYTES,
        () => new PreviewAutomationRecordingTransferError({ threadId }),
      ),
    );
  yield* Effect.gen(function* () {
    yield* validateFile(currentPath);
    yield* fileSystem.rename(currentPath, finalPath);
  }).pipe(
    Effect.catchIf(
      (cause) =>
        cause._tag !== "PreviewAutomationRecordingTransferError" &&
        cause.reason._tag === "NotFound",
      () => validateFile(finalPath),
    ),
    Effect.mapError((cause) => new PreviewAutomationRecordingTransferError({ threadId, cause })),
  );
  const { uploadedAttachmentId: _uploadedAttachmentId, ...recording } = artifact;
  return { ...recording, id: finalId, path: finalPath };
});

const handlers = {
  browser_site_note_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const notes = yield* requireSiteNotes;
      if (!notes.hasTouched(scope.thread.threadId, input.origin))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Site notes are readable only for sites this thread has opened.",
        });
      return { note: notes.noteFor(input.origin) ?? null };
    }),
  ),
  browser_site_note_write: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const notes = yield* requireSiteNotes;
      yield* notes.writeAgent(scope.thread.threadId, input).pipe(
        Effect.mapError((error) => new OrchestratorMcpFailure({
          code: error._tag === "SiteNoteError" ? "invalid_request" : "orchestration_error",
          message: error._tag === "SiteNoteError" ? `Site note rejected: ${error.reason}.` : "Site note storage failed.",
        })),
      );
      return { ok: true as const };
    }),
  ),
  preview_dialog: McpToolAccess.destructive(
    McpToolAccess.actsAsCaller((input) => invokeTargeted<PreviewAutomationStatus>("dialog", input)),
  ),
  preview_status: McpToolAccess.readsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("status", input ?? {}),
  ),
  preview_open: McpToolAccess.destructive(
    McpToolAccess.actsAsCaller(
      (input) =>
        Effect.gen(function* () {
          yield* McpInvocationContext.requireThreadMcpCapability("preview");
          yield* McpToolAccess.admit(input);
          return yield* invokeTargeted<PreviewAutomationStatus>(
            "open",
            normalizePreviewOpenInput(input),
          );
        }),
      { admission: "handler" },
    ),
  ),
  preview_navigate: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
  ),
  preview_back: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("back", input, input.timeoutMs),
  ),
  preview_forward: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("forward", input, input.timeoutMs),
  ),
  preview_reload: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("reload", input, input.timeoutMs),
  ),
  preview_resize: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
  ),
  preview_set_appearance: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationSetColorSchemeResult>("setColorScheme", input),
  ),
  preview_snapshot: McpToolAccess.readsAsCaller((input) => {
    const { includeImage, save, ...operationInput } = input ?? {};
    // Nothing shows or saves the image, so the browser skips the capture (L4).
    const captureImage = includeImage === true || save === true;
    return invokeTargeted<PreviewAutomationSnapshot>("snapshot", {
      ...operationInput,
      captureImage,
    });
  }),
  preview_logs: McpToolAccess.readsAsCaller((input) =>
    invokeTargeted<PreviewAutomationLogs>("logs", input),
  ),
  goat_preview_read: McpToolAccess.readsAsCaller((input) =>
    invokeTargeted<PreviewAutomationRead>("read", input, (input.timeoutMs ?? 10_000) + 2_000),
  ),
  goat_preview_fetch: McpToolAccess.readsAsCaller((input) =>
    invokeTargeted<PreviewAutomationFetchResult>("fetch", input, input.timeoutMs),
  ),
  goat_preview_scroll_collect: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationScrollCollectResult>("scrollCollect", input, input.timeoutMs),
  ),
  preview_click: McpToolAccess.destructive(
    McpToolAccess.actsAsCaller((input) => invokeTargeted<object>("click", input, input.timeoutMs)),
  ),
  preview_type: McpToolAccess.destructive(
    McpToolAccess.actsAsCaller((input) => invokeTargeted<object>("type", input, input.timeoutMs)),
  ),
  goat_preview_fill_secret: McpToolAccess.destructive(
    McpToolAccess.actsAsCaller((input) =>
      invokeTargeted<PreviewAutomationFillSecretResult>("fillSecret", input, input.timeoutMs),
    ),
  ),
  preview_hover: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<object>("hover", input, input.timeoutMs),
  ),
  preview_select: McpToolAccess.destructive(
    McpToolAccess.actsAsCaller((input) =>
      invokeTargeted<PreviewAutomationSelectResult>("select", input, input.timeoutMs),
    ),
  ),
  preview_drag: McpToolAccess.destructive(
    McpToolAccess.actsAsCaller((input) => invokeTargeted<object>("drag", input, input.timeoutMs)),
  ),
  preview_upload: McpToolAccess.destructive(
    McpToolAccess.actsAsCaller((input) => invokeTargeted<object>("upload", input, input.timeoutMs)),
  ),
  preview_press: McpToolAccess.destructive(
    McpToolAccess.actsAsCaller((input) => invokeTargeted<object>("press", input)),
  ),
  preview_scroll: McpToolAccess.actsAsCaller((input) => invokeTargeted<object>("scroll", input)),
  preview_evaluate: McpToolAccess.destructive(
    McpToolAccess.actsAsCaller(({ tabId, ...input }) =>
      invoke<unknown>("evaluate", input, undefined, tabId).pipe(
        Effect.map(({ result, toolIcon, safety }) => ({
          value: result ?? null,
          ...(safety === undefined ? {} : { safety }),
          ...(toolIcon ? { toolIcon } : {}),
        })),
      ),
    ),
  ),
  preview_wait_for: McpToolAccess.readsAsCaller((input) =>
    invokeTargeted<object>("waitFor", input, input.timeoutMs),
  ),
  preview_recording_start: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationRecordingStatus>("recordingStart", input ?? {}),
  ),
  preview_recording_stop: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const { tabId, ...operationInput } = input;
      const response = yield* invoke<unknown>(
        "recordingStop",
        { ...operationInput, transferToEnvironment: true },
        PREVIEW_RECORDING_STOP_TIMEOUT_MS,
        tabId,
      );
      const artifact = yield* claimPreviewRecording(scope.thread.threadId, response.result);
      return {
        ...artifact,
        ...(response.safety === undefined ? {} : { safety: response.safety }),
        ...(response.toolIcon ? { toolIcon: response.toolIcon } : {}),
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof PreviewToolkit.tools>;

const { preview_snapshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(PreviewStandardToolkit, standardHandlers);

export const layerSnapshot = McpToolAccess.toLayer(PreviewSnapshotToolkit, {
  preview_snapshot,
});

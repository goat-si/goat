import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import {
  prewarmEnvironmentVoice,
  resolveTranscriptCommit,
  resolveVoiceTranscriptionRoute,
  transcribeEnvironmentVoice,
  voiceInputBlocksSubmission,
  voiceTranscriptionRequest,
  type EnvironmentVoiceRequestContext,
  type VoiceDraftSnapshot,
  type VoiceInputState,
  type VoiceTranscriptionRoute,
} from "@goat/client-runtime/voice-input";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { flushSync } from "react-dom";
import * as Effect from "effect/Effect";
import { ManagedRelay } from "@goat/client-runtime/relay";
import { RemoteEnvironmentAuthorization } from "@goat/client-runtime/authorization/service";
import { createRuntimeCommand, squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { useStableCallback } from "../../hooks/useStableCallback";
import { composerTargetKey, useComposerDraftStore } from "../../composerDraftStore";
import { usePrimaryEnvironmentId } from "../../state/environments";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { expandCollapsedComposerCursor } from "../../composer-logic";
import { collectInlineContextIds } from "../../lib/composerContextReferences";
import {
  formatVoiceRecordingDuration,
  isVoiceRecordingCancelledError,
  useVoiceRecorder,
  VoiceMicrophoneError,
  type VoiceRecordingOptions,
  type VoiceRecordingPayload,
} from "../../lib/voiceRecorder";

export interface ComposerVoiceTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly ownerKey: string;
  readonly cwd: string | null;
  readonly locale: string;
  readonly enabled: boolean;
  /** Where this composer's audio is transcribed; see resolveVoiceTranscriptionRoute. */
  readonly route: VoiceTranscriptionRoute;
}

interface VoiceControllerState extends VoiceInputState {
  readonly streamingPreviewText: string;
}

export interface ComposerVoiceDependencies {
  readonly startRecording: (options: VoiceRecordingOptions) => Promise<void>;
  readonly stopRecording: () => Promise<VoiceRecordingPayload | null>;
  readonly cancelRecording: () => Promise<void>;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (text: string, selection: VoiceDraftSnapshot["selection"]) => void;
  readonly onSubmit: (text: string) => void;
  readonly prewarm: (target: ComposerVoiceTarget, signal: AbortSignal) => Promise<unknown>;
  readonly transcribe: (
    target: ComposerVoiceTarget,
    payload: VoiceRecordingPayload,
    signal: AbortSignal,
  ) => Promise<{ readonly text: string }>;
}

const IDLE: VoiceControllerState = {
  phase: "idle",
  error: null,
  errorAction: null,
  streamingPreviewText: "",
};

export class ComposerVoiceController {
  private state = IDLE;
  private generation = 0;
  private abort: AbortController | null = null;
  private previewAbort: AbortController | null = null;
  private previewEpoch = 0;
  private sequence = 0;
  private appliedSequence = 0;
  private queued: { sequence: number; payload: VoiceRecordingPayload } | null = null;
  private captured: VoiceDraftSnapshot | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private target: ComposerVoiceTarget,
    private readonly dependencies: ComposerVoiceDependencies,
  ) {}

  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly blocksSubmission = () => voiceInputBlocksSubmission(this.state);

  private publish(state: VoiceControllerState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  readonly setTarget = (target: ComposerVoiceTarget) => {
    const previous = this.target;
    this.target = target;
    if (
      previous.environmentId !== target.environmentId ||
      previous.threadId !== target.threadId ||
      previous.providerInstanceId !== target.providerInstanceId ||
      previous.ownerKey !== target.ownerKey ||
      previous.cwd !== target.cwd ||
      previous.locale !== target.locale ||
      routeKey(previous.route) !== routeKey(target.route) ||
      (previous.enabled && !target.enabled)
    ) {
      this.cancel();
    }
  };

  private retirePreviews() {
    this.previewEpoch++;
    this.previewAbort?.abort();
    this.previewAbort = null;
    this.queued = null;
  }

  readonly cancel = () => {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.captured = null;
    this.retirePreviews();
    this.publish(IDLE);
    void this.dependencies.cancelRecording();
  };

  readonly start = async (): Promise<void> => {
    if (!this.target.enabled || this.blocksSubmission()) return;
    if (this.target.route.kind === "unavailable") {
      this.publish({
        ...IDLE,
        phase: "error",
        error:
          "Desktop voice input records and transcribes on this computer. Turn on Local environment in Settings › Connections to use it.",
        errorAction: null,
      });
      return;
    }
    const draft = this.dependencies.readDraft();
    if (!draft || draft.ownerKey !== this.target.ownerKey) return;
    const generation = ++this.generation;
    const target = this.target;
    this.captured = { ...draft, selection: { ...draft.selection } };
    const abort = new AbortController();
    this.abort = abort;
    this.sequence = 0;
    this.appliedSequence = 0;
    this.publish({ ...IDLE, phase: "preparing" });
    // Warming the server must never delay microphone access or make recording fail.
    void Promise.resolve()
      .then(() => {
        if (!abort.signal.aborted) return this.dependencies.prewarm(target, abort.signal);
      })
      .catch(() => undefined);
    try {
      await this.dependencies.startRecording({
        onStreamingChunk: (payload) => {
          if (generation === this.generation) this.enqueuePreview(payload);
        },
        onLimitReached: () => {
          if (generation === this.generation) void this.confirm();
        },
        onError: (error) => {
          if (generation === this.generation) this.fail(error);
        },
      });
      if (generation === this.generation) this.publish({ ...this.state, phase: "recording" });
    } catch (error) {
      if (generation !== this.generation || isVoiceRecordingCancelledError(error)) return;
      this.fail(error);
    }
  };

  private fail(error: unknown) {
    this.abort?.abort();
    this.retirePreviews();
    this.publish({
      ...IDLE,
      phase: "error",
      error: error instanceof Error ? error.message : "Voice transcription failed.",
      errorAction:
        error instanceof VoiceMicrophoneError && error.opensSystemSettings ? "settings" : "retry",
    });
  }

  private enqueuePreview(payload: VoiceRecordingPayload) {
    if (this.state.phase !== "recording") return;
    this.queued = { sequence: ++this.sequence, payload };
    if (!this.previewAbort) void this.drainPreview();
  }

  private async drainPreview(): Promise<void> {
    const chunk = this.queued;
    if (!chunk || this.state.phase !== "recording") return;
    this.queued = null;
    const abort = new AbortController();
    this.previewAbort = abort;
    const generation = this.generation;
    const epoch = this.previewEpoch;
    const target = this.target;
    try {
      const result = await this.dependencies.transcribe(target, chunk.payload, abort.signal);
      if (
        generation === this.generation &&
        epoch === this.previewEpoch &&
        !abort.signal.aborted &&
        this.state.phase === "recording" &&
        chunk.sequence > this.appliedSequence
      ) {
        this.appliedSequence = chunk.sequence;
        const text = result.text.trim();
        if (text)
          this.publish({
            ...this.state,
            streamingPreviewText: [this.state.streamingPreviewText, text].filter(Boolean).join(" "),
          });
      }
    } catch {
      // Chunk previews are best effort; the complete recording is transcribed on confirmation.
    } finally {
      if (this.previewAbort === abort) {
        this.previewAbort = null;
        if (generation === this.generation && epoch === this.previewEpoch) void this.drainPreview();
      }
    }
  }

  readonly confirm = () => this.finish(false);
  readonly send = () => this.finish(true);

  private async finish(send: boolean): Promise<boolean> {
    if (this.state.phase !== "recording" || !this.captured || !this.abort) return false;
    const generation = this.generation;
    const target = this.target;
    const captured = this.captured;
    const signal = this.abort.signal;
    const isCurrent = () => generation === this.generation && !signal.aborted;
    this.retirePreviews();
    this.publish({ ...this.state, phase: "transcribing", streamingPreviewText: "" });
    try {
      const payload = await this.dependencies.stopRecording();
      if (!isCurrent()) return false;
      if (!payload) throw new Error("No audio was captured. Check your microphone and try again.");
      const result = await this.dependencies.transcribe(target, payload, signal);
      if (!isCurrent()) return false;
      const commit = resolveTranscriptCommit(
        captured,
        this.dependencies.readDraft(),
        result.text,
        target.locale,
      );
      if (commit.kind !== "commit") {
        this.publish(
          commit.kind === "stale"
            ? {
                ...IDLE,
                phase: "error",
                error: "The draft changed while recording. Record again to insert voice text.",
                errorAction: "retry",
              }
            : IDLE,
        );
        return false;
      }
      this.captured = null;
      this.publish(IDLE);
      this.dependencies.commitDraft(commit.text, commit.selection);
      if (send && commit.text.trim() && isCurrent()) this.dependencies.onSubmit(commit.text);
      return true;
    } catch (error) {
      if (isCurrent()) this.fail(error);
      return false;
    }
  }
}

export interface UseComposerVoiceControllerOptions extends ComposerVoiceTarget {
  readonly readDraft: ComposerVoiceDependencies["readDraft"];
  readonly commitDraft: ComposerVoiceDependencies["commitDraft"];
  readonly onSubmit: ComposerVoiceDependencies["onSubmit"];
  readonly onStart?: () => void;
  readonly subscribeDraft?: (listener: () => void) => () => void;
  readonly resolveContext?: (
    environmentId: EnvironmentId,
  ) => Promise<EnvironmentVoiceRequestContext | null>;
}

export function useComposerVoiceController(options: UseComposerVoiceControllerOptions) {
  const recorder = useVoiceRecorder();
  const draftVersionRef = useRef<{ snapshot: VoiceDraftSnapshot | null; revision: number }>({
    snapshot: null,
    revision: 0,
  });
  const readDraft = useStableCallback(() => {
    const draftVersion = draftVersionRef.current;
    const snapshot = options.readDraft();
    if (
      snapshot?.text !== draftVersion.snapshot?.text ||
      snapshot?.ownerKey !== draftVersion.snapshot?.ownerKey ||
      snapshot?.revision !== draftVersion.snapshot?.revision
    )
      draftVersion.revision++;
    draftVersion.snapshot = snapshot;
    return snapshot ? { ...snapshot, revision: draftVersion.revision } : null;
  });
  const commitDraft = useStableCallback(
    (text: string, selection: VoiceDraftSnapshot["selection"]) => {
      flushSync(() => options.commitDraft(text, selection));
    },
  );
  const onSubmit = useStableCallback(options.onSubmit);
  const resolveContext = useStableCallback(options.resolveContext ?? resolveComposerVoiceContext);
  const [controller] = useState(
    () =>
      new ComposerVoiceController(options, {
        startRecording: recorder.startRecording,
        stopRecording: recorder.stopRecording,
        cancelRecording: recorder.cancelRecording,
        readDraft,
        commitDraft,
        onSubmit,
        prewarm: async (target, signal) => {
          const request = voiceTranscriptionRequest(target.route, target);
          if (!request) return;
          const context = await resolveContext(request.environmentId);
          if (!context || signal.aborted) return;
          return prewarmEnvironmentVoice(context, request.routing, { signal });
        },
        transcribe: async (target, payload, signal) => {
          const request = voiceTranscriptionRequest(target.route, target);
          if (!request) throw new Error("Voice input has nowhere to transcribe this recording.");
          const context = await resolveContext(request.environmentId);
          signal.throwIfAborted();
          if (!context) throw new Error("Connect to an environment before transcribing voice.");
          return transcribeEnvironmentVoice(
            context,
            { ...payload, ...request.routing, locale: target.locale },
            { signal },
          );
        },
      }),
  );
  // oxlint-disable-next-line goat/react-effect-budget -- Retire microphone and network work before a navigation commit can receive stale results.
  useLayoutEffect(() => {
    controller.setTarget(options);
  }, [controller, options]);
  // oxlint-disable-next-line goat/react-effect-budget -- The controller owns cancellable recording and HTTP requests for this mounted composer.
  useLayoutEffect(() => () => controller.cancel(), [controller]);
  const subscribeDraft = options.subscribeDraft;
  // oxlint-disable-next-line goat/react-effect-budget -- Observe draft edits before asynchronous transcription completes, including edit then undo.
  useLayoutEffect(
    () =>
      subscribeDraft?.(() => {
        readDraft();
      }),
    [subscribeDraft, readDraft],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return {
    state,
    voiceControl: {
      disabled: !options.enabled || voiceInputBlocksSubmission(state),
      onClick: () => {
        options.onStart?.();
        void controller.start();
      },
    },
    isVoiceActive: voiceInputBlocksSubmission(state),
    canStart: options.enabled && !voiceInputBlocksSubmission(state),
    blocksSubmission: controller.blocksSubmission,
    isVoiceStarting: state.phase === "preparing",
    isVoiceRecording: state.phase === "recording",
    isVoiceTranscribing: state.phase === "transcribing",
    isVoiceWaitingForAudio: state.phase === "recording" && !recorder.hasAudioSignal,
    voiceWaveformLevels: recorder.waveformLevels,
    voiceRecordingDurationLabel: formatVoiceRecordingDuration(recorder.durationMs),
    streamingPreviewText: state.streamingPreviewText,
    transcriptionRoute: options.route,
    start: controller.start,
    confirm: controller.confirm,
    send: controller.send,
    cancel: controller.cancel,
    /** Composer errors win; a macOS microphone denial adds a way to fix it. */
    validation: (composerError: string | null) =>
      composerError
        ? { message: composerError }
        : {
            message: state.error,
            action:
              state.errorAction === "settings"
                ? { label: "Open System Settings", onClick: openMicrophoneSettings }
                : null,
          },
  };
}

function openMicrophoneSettings() {
  void window.desktopBridge?.openSystemSettings?.("microphone").catch(() => false);
}

export function useChatComposerVoiceController(
  options: Omit<
    UseComposerVoiceControllerOptions,
    "ownerKey" | "readDraft" | "locale" | "subscribeDraft" | "commitDraft" | "route"
  > & {
    readonly draftTarget: Parameters<typeof composerTargetKey>[0];
    readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
    readonly promptRef: RefObject<string>;
    readonly replacePrompt: (
      start: number,
      end: number,
      text: string,
      options: { expandedCursorAfterReplace: number },
    ) => boolean;
  },
) {
  const ownerKey = composerTargetKey(options.draftTarget);
  // The desktop app transcribes on its own machine; a browser or phone uses the thread's server.
  const route = resolveVoiceTranscriptionRoute({
    requiresLocalRuntime: typeof window !== "undefined" && window.desktopBridge !== undefined,
    localEnvironmentId: usePrimaryEnvironmentId(),
    threadEnvironmentId: options.environmentId,
  });
  return useComposerVoiceController({
    ...options,
    ownerKey,
    route,
    locale: typeof navigator === "undefined" ? "en-US" : navigator.language || "en-US",
    subscribeDraft: useComposerDraftStore.subscribe,
    readDraft: () => {
      const text =
        useComposerDraftStore.getState().getComposerDraft(options.draftTarget)?.prompt ?? "";
      return {
        ownerKey,
        text,
        revision: 0,
        selection: options.editorRef.current?.readSelectionRange() ?? {
          start: text.length,
          end: text.length,
        },
      };
    },
    commitDraft: (text, selection) => {
      options.replacePrompt(0, options.promptRef.current.length, text, {
        expandedCursorAfterReplace: selection.end,
      });
    },
  });
}

const routeKey = (route: VoiceTranscriptionRoute) =>
  route.kind === "unavailable" ? route.kind : `${route.kind}:${route.environmentId}`;

export function readDraftSnapshot(
  editor: ComposerPromptEditorHandle | null,
  value: string,
  cursor: number,
  literalText: boolean,
) {
  return (
    editor?.readSnapshot() ?? {
      value,
      cursor,
      expandedCursor: expandCollapsedComposerCursor(value, cursor, literalText),
      contextIds: literalText ? [] : collectInlineContextIds(value),
    }
  );
}

async function resolveComposerVoiceContext(
  environmentId: EnvironmentId,
): Promise<EnvironmentVoiceRequestContext | null> {
  const [{ connectionAtomRuntime }, { appAtomRegistry }, { readPreparedConnection }] =
    await Promise.all([
      import("../../connection/runtime"),
      import("../../rpc/atomRegistry"),
      import("../../state/session"),
    ]);
  const command = createRuntimeCommand(connectionAtomRuntime, {
    label: "web:composer:voice-context",
    execute: Effect.fn("composerVoice.resolveContext")(function* (
      targetEnvironmentId: EnvironmentId,
    ) {
      const prepared = readPreparedConnection(targetEnvironmentId);
      if (!prepared) return null;
      const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
      const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
      return { prepared, signer, remoteAuthorization };
    }),
  });
  const result = await command.run(appAtomRegistry, environmentId);
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

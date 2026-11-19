import {
  AuthOrchestrationOperateScope,
  DEFAULT_SPEECH_CONFIGURATION,
  type EnvironmentId,
  type ProviderInstanceId,
  type ThreadId,
} from "@goat/contracts";
import {
  prewarmEnvironmentVoice,
  resolveTranscriptCommit,
  resolveVoiceTranscriptionRoute,
  transcribeEnvironmentVoice,
  transcribeLocalModel,
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
import { toastManager } from "../ui/toast";
import { composerTargetKey, useComposerDraftStore } from "../../composerDraftStore";
import { readThreadShell } from "../../state/entities";
import { MAX_UNATTACHED_VOICE_TRANSCRIPTS, voiceSession } from "../../speech/voiceSession";
import { captureBackgroundVoiceDraft } from "../../speech/backgroundVoiceDraft";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  readEnvironmentProxiedByHub,
  readEnvironmentScope,
  useEnvironmentScope,
  usePreparedConnection,
  useEnvironmentsWithScope,
} from "../../state/session";
import {
  chooseEnvironmentSpeech,
  isEnvironmentSpeechGrantCurrent,
  useEnvironmentSpeechGrant,
  type EnvironmentSpeechGrant,
} from "../../speech/voiceConsent";
import * as Option from "effect/Option";
import { useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "../../state/server";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { expandCollapsedComposerCursor } from "../../composer-logic";
import { collectInlineContextIds } from "../../lib/composerContextReferences";
import {
  formatVoiceRecordingDuration,
  isVoiceRecordingCancelledError,
  BrowserVoiceRecorder,
  VoiceMicrophoneError,
  type VoiceRecordingOptions,
  type VoiceRecordingPayload,
} from "../../lib/voiceRecorder";

export interface ComposerVoiceTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly ownerKey: string;
  readonly cwd: string | null;
  readonly locale: string;
  readonly enabled: boolean;
  /** Where this composer's audio is transcribed; see resolveVoiceTranscriptionRoute. */
  readonly route: VoiceTranscriptionRoute;
  readonly localModelGrant?: EnvironmentSpeechGrant | null;
}

interface VoiceControllerState extends VoiceInputState {
  readonly streamingPreviewText: string;
  readonly unattachedTranscript?: string;
}

export interface ComposerVoiceDependencies {
  readonly startRecording: (options: VoiceRecordingOptions) => Promise<void>;
  readonly stopRecording: () => Promise<VoiceRecordingPayload | null>;
  readonly cancelRecording: () => Promise<void>;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (text: string, selection: VoiceDraftSnapshot["selection"]) => void;
  readonly onSubmit?: ((text: string) => void) | undefined;
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
  private submitHandler: ComposerVoiceDependencies["onSubmit"];
  private readonly listeners = new Set<() => void>();

  constructor(
    private target: ComposerVoiceTarget,
    private readonly dependencies: ComposerVoiceDependencies,
  ) {
    this.submitHandler = dependencies.onSubmit;
  }

  readonly setSubmitHandler = (handler: ComposerVoiceDependencies["onSubmit"]) => {
    this.submitHandler = handler;
  };

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
      previous.localModelGrant?.id !== target.localModelGrant?.id ||
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
    if (
      this.target.localModelGrant &&
      !isEnvironmentSpeechGrantCurrent(this.target.localModelGrant)
    )
      return;
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
          if (!target.localModelGrant && generation === this.generation)
            this.enqueuePreview(payload);
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

  private fail(error: unknown, unattachedTranscript?: string) {
    this.abort?.abort();
    this.retirePreviews();
    this.publish({
      ...IDLE,
      phase: "error",
      error: error instanceof Error ? error.message : "Voice transcription failed.",
      errorAction:
        error instanceof VoiceMicrophoneError && error.opensSystemSettings ? "settings" : "retry",
      ...(unattachedTranscript?.trim() ? { unattachedTranscript } : {}),
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
    if (send && !this.submitHandler) return false;
    if (this.state.phase !== "recording" || !this.captured || !this.abort) return false;
    const generation = this.generation;
    const target = this.target;
    const captured = this.captured;
    const signal = this.abort.signal;
    const isCurrent = () => generation === this.generation && !signal.aborted;
    let unattachedTranscript: string | undefined;
    this.retirePreviews();
    this.publish({ ...this.state, phase: "transcribing", streamingPreviewText: "" });
    try {
      const payload = await this.dependencies.stopRecording();
      if (!isCurrent()) return false;
      if (!payload) throw new Error("No audio was captured. Check your microphone and try again.");
      const result = await this.dependencies.transcribe(target, payload, signal);
      if (!isCurrent()) return false;
      unattachedTranscript = result.text;
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
                error: "The draft changed while recording. The transcript was kept separately.",
                errorAction: "retry",
                unattachedTranscript: result.text,
              }
            : IDLE,
        );
        return false;
      }
      this.captured = null;
      this.dependencies.commitDraft(commit.text, commit.selection);
      unattachedTranscript = undefined;
      this.publish(IDLE);
      if (send && commit.text.trim() && isCurrent()) this.submitHandler?.(commit.text);
      return true;
    } catch (error) {
      if (isCurrent()) this.fail(error, unattachedTranscript);
      return false;
    }
  }
}

export interface UseComposerVoiceControllerOptions extends ComposerVoiceTarget {
  readonly readDraft: ComposerVoiceDependencies["readDraft"];
  readonly commitDraft: ComposerVoiceDependencies["commitDraft"];
  readonly onSubmit?: ComposerVoiceDependencies["onSubmit"];
  readonly onStart?: () => void;
  readonly subscribeDraft?: (listener: () => void) => () => void;
  readonly resolveContext?: (
    environmentId: EnvironmentId,
  ) => Promise<EnvironmentVoiceRequestContext | null>;
  readonly captureBackgroundDraft?: () => {
    readonly readDraft: ComposerVoiceDependencies["readDraft"];
    readonly commitDraft: ComposerVoiceDependencies["commitDraft"];
    readonly dispose: () => void;
  };
}

export function useComposerVoiceController(options: UseComposerVoiceControllerOptions) {
  const [recorder] = useState(() => new BrowserVoiceRecorder());
  const registry = useSyncExternalStore(
    voiceSession.subscribe,
    voiceSession.getSnapshot,
    voiceSession.getSnapshot,
  );
  const currentRecorder =
    registry.active?.ownerKey === options.ownerKey
      ? (registry.active.recorder ?? recorder)
      : recorder;
  const recorderState = useSyncExternalStore(
    currentRecorder.subscribe,
    currentRecorder.getSnapshot,
    currentRecorder.getSnapshot,
  );
  const background = useRef<ReturnType<
    NonNullable<UseComposerVoiceControllerOptions["captureBackgroundDraft"]>
  > | null>(null);
  const mounted = useRef(true);
  const draftVersionRef = useRef<{ snapshot: VoiceDraftSnapshot | null; revision: number }>({
    snapshot: null,
    revision: 0,
  });
  const readDraft = useStableCallback(() => {
    if (background.current) return background.current.readDraft();
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
      const binding = background.current;
      flushSync(() => {
        if (binding) binding.commitDraft(text, selection);
        else options.commitDraft(text, selection);
      });
    },
  );
  const onSubmit = useStableCallback((text: string) => {
    if (mounted.current && (!registry.active || registry.active.ownerKey === options.ownerKey))
      options.onSubmit?.(text);
  });
  const resolveContext = useStableCallback(options.resolveContext ?? resolveComposerVoiceContext);
  const [localController] = useState(
    () =>
      new ComposerVoiceController(options, {
        startRecording: recorder.startRecording,
        stopRecording: recorder.stopRecording,
        cancelRecording: recorder.cancelRecording,
        readDraft,
        commitDraft,
        ...(options.onSubmit ? { onSubmit } : {}),
        prewarm: async (target, signal) => {
          if (target.localModelGrant) return;
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
          if (target.localModelGrant) {
            const grant = target.localModelGrant;
            return transcribeLocalModel(
              context,
              { ...payload, locale: target.locale },
              {
                signal,
                canSend: () =>
                  isEnvironmentSpeechGrantCurrent(grant) &&
                  readEnvironmentScope(request.environmentId, AuthOrchestrationOperateScope) &&
                  !readEnvironmentProxiedByHub(request.environmentId),
              },
            );
          }
          return transcribeEnvironmentVoice(
            context,
            { ...payload, ...request.routing, locale: target.locale },
            { signal },
          );
        },
      }),
  );
  const controller =
    registry.active?.ownerKey === options.ownerKey
      ? (registry.active.controller as ComposerVoiceController)
      : localController;
  const ownsController = !registry.active || registry.active.ownerKey === options.ownerKey;
  const start = async () => {
    const session = voiceSession.getSnapshot();
    if (
      session.active ||
      session.unattached.length >= MAX_UNATTACHED_VOICE_TRANSCRIPTS ||
      !options.enabled
    )
      return;
    const binding = options.captureBackgroundDraft?.() ?? null;
    background.current = binding;
    await voiceSession.start({
      ownerKey: options.ownerKey,
      persistent: binding !== null,
      environmentId:
        options.route.kind === "unavailable" ? options.environmentId : options.route.environmentId,
      controller: localController,
      recorder,
      dispose: () => {
        binding?.dispose();
        background.current = null;
      },
    });
  };
  // oxlint-disable-next-line goat/react-effect-budget -- Retire microphone and network work before a navigation commit can receive stale results.
  useLayoutEffect(() => {
    if (!registry.active || registry.active.ownerKey === options.ownerKey) {
      controller.setTarget(options);
      controller.setSubmitHandler(options.onSubmit ? onSubmit : undefined);
    }
  }, [controller, options, registry.active, onSubmit]);
  // oxlint-disable-next-line goat/react-effect-budget -- The controller owns cancellable recording and HTTP requests for this mounted composer.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      voiceSession.ownerUnmounted(localController);
    };
  }, [localController]);
  const subscribeDraft = options.subscribeDraft;
  // oxlint-disable-next-line goat/react-effect-budget -- Observe draft edits before asynchronous transcription completes, including edit then undo.
  useLayoutEffect(
    () =>
      subscribeDraft?.(() => {
        readDraft();
      }),
    [subscribeDraft, readDraft],
  );
  const controllerState = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const state = ownsController ? controllerState : IDLE;
  return {
    state,
    voiceControl: {
      disabled:
        !options.enabled ||
        registry.active !== null ||
        registry.unattached.length >= MAX_UNATTACHED_VOICE_TRANSCRIPTS ||
        voiceInputBlocksSubmission(state),
      onClick: () => {
        options.onStart?.();
        void start();
      },
    },
    isVoiceActive: voiceInputBlocksSubmission(state),
    canStart:
      options.enabled &&
      registry.active === null &&
      registry.unattached.length < MAX_UNATTACHED_VOICE_TRANSCRIPTS &&
      !voiceInputBlocksSubmission(state),
    blocksSubmission: () => ownsController && controller.blocksSubmission(),
    isVoiceStarting: state.phase === "preparing",
    isVoiceRecording: state.phase === "recording",
    isVoiceTranscribing: state.phase === "transcribing",
    isVoiceWaitingForAudio: state.phase === "recording" && !recorderState.hasAudioSignal,
    voiceWaveformLevels: recorderState.waveformLevels,
    voiceRecordingDurationLabel: formatVoiceRecordingDuration(recorderState.durationMs),
    streamingPreviewText: state.streamingPreviewText,
    transcriptionRoute: options.route,
    start,
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
  const grant = useEnvironmentSpeechGrant();
  const selectedGrant = grant;
  const destinationId = selectedGrant?.environmentId ?? options.environmentId;
  const { environments } = useEnvironments();
  const permitted = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const destinations = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      permitted.has(environment.environmentId) &&
      environment.entry.target._tag !== "HubProxyConnectionTarget",
  );
  const hasScope = useEnvironmentScope(destinationId, AuthOrchestrationOperateScope);
  const connection = usePreparedConnection(destinationId);
  const isProxied =
    Option.isSome(connection) && connection.value.target._tag === "HubProxyConnectionTarget";
  const environmentLabel = useEnvironment(destinationId)?.label ?? "this environment";
  const canManage = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(destinationId, {
      patch: { speech: DEFAULT_SPEECH_CONFIGURATION },
    }),
  );
  const localEnvironmentId = usePrimaryEnvironmentId();
  // The desktop app transcribes on its own machine; a browser or phone uses the thread's server.
  const route = selectedGrant
    ? { kind: "environment" as const, environmentId: destinationId }
    : resolveVoiceTranscriptionRoute({
        requiresLocalRuntime: typeof window !== "undefined" && window.desktopBridge !== undefined,
        localEnvironmentId,
        threadEnvironmentId: options.environmentId,
      });
  const controller = useComposerVoiceController({
    ...options,
    ownerKey,
    route,
    localModelGrant: selectedGrant,
    enabled:
      options.enabled && (!selectedGrant || (hasScope && Option.isSome(connection) && !isProxied)),
    locale: typeof navigator === "undefined" ? "en-US" : navigator.language || "en-US",
    subscribeDraft: useComposerDraftStore.subscribe,
    ...(typeof options.draftTarget !== "string" && options.threadId !== null
      ? {
          captureBackgroundDraft: () => {
            const target = options.draftTarget;
            if (typeof target === "string") throw new Error("A thread draft is required.");
            const current = useComposerDraftStore.getState().getComposerDraft(target);
            const text = current?.prompt ?? "";
            return captureBackgroundVoiceDraft({
              ownerKey,
              selection: options.editorRef.current?.readSelectionRange() ?? {
                start: text.length,
                end: text.length,
              },
              read: () => useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? null,
              exists: () => readThreadShell(target) !== null,
              write: (next) => useComposerDraftStore.getState().setPrompt(target, next),
              subscribe: useComposerDraftStore.subscribe,
            });
          },
        }
      : {}),
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
  return {
    ...controller,
    voiceControl: {
      ...controller.voiceControl,
      environmentSpeech: {
        label: environmentLabel,
        selected: selectedGrant !== null,
        environmentId: destinationId,
        canManage: canManage && Option.isSome(connection) && !isProxied,
        resolveContext: resolveComposerVoiceContext,
        destinations: destinations.map(({ environmentId, label }) => ({ environmentId, label })),
        enable: (id: EnvironmentId) => {
          if (
            readEnvironmentScope(id, AuthOrchestrationOperateScope) &&
            !readEnvironmentProxiedByHub(id)
          )
            reportVoiceChoice(chooseEnvironmentSpeech(id));
        },
        disable: () => reportVoiceChoice(chooseEnvironmentSpeech(null)),
      },
    },
  };
}

function reportVoiceChoice(result: ReturnType<typeof chooseEnvironmentSpeech>) {
  if (result === "saved") return;
  toastManager.add(
    result === "unsupported"
      ? {
          type: "error",
          title: "This browser can't use environment dictation",
          description:
            "It can't turn dictation off in your other tabs, so existing voice input stays on.",
        }
      : {
          type: "error",
          title: "Could not save the dictation choice",
          description:
            "Environment dictation is off in open tabs. A reload may restore the previous choice.",
        },
  );
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

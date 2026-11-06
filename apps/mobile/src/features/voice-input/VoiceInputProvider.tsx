import { RegistryContext, useAtomMount, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES,
  type EnvironmentId,
} from "@goat/contracts";
import {
  AudioModule,
  IOSOutputFormat,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { useSharedValue } from "react-native-reanimated";

import {
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../../lib/microphonePriority";
import { getLocalVoiceTranscriber, getVoiceTranscriber } from "../../native/voiceTranscription";
import { environmentSession } from "../../state/session";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  createRemoteVoiceTranscriber,
  transcribeLocalModelEffect,
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@goat/client-runtime/voice-input";
import { createLazyVoiceRecorder } from "./lazyVoiceRecorder";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";
import { createEnvironmentWavTranscriber } from "./environmentWavTranscriber";
import { voiceGrantAtom } from "./voiceGrant";
import { voiceRequestContextsAtom } from "./voiceEnvironment";
import { runMobileSpeechRequest } from "./mobileSpeechRequest";
import { sessionHasScope, useEnvironmentScope, usePreparedConnection } from "../../state/session";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const VOICE_METERING_INTERVAL_MS = 80;
// The native constructor expects platform-flattened options, as built by useAudioRecorder.
const VOICE_RECORDING_OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
  bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
  isMeteringEnabled: true,
  ...(Platform.OS === "ios"
    ? {
        extension: ".wav",
        sampleRate: 24_000,
        numberOfChannels: 1,
        outputFormat: IOSOutputFormat.LINEARPCM,
        linearPCMBitDepth: 16,
        linearPCMIsBigEndian: false,
        linearPCMIsFloat: false,
      }
    : RecordingPresets.HIGH_QUALITY.android),
};

const VoiceInputContext = createContext<ReturnType<typeof useVoiceInputRuntime> | null>(null);

export function VoiceInputProvider({ children }: { readonly children: ReactNode }) {
  const runtime = useVoiceInputRuntime();
  return <VoiceInputContext value={runtime}>{children}</VoiceInputContext>;
}

export function useGlobalVoiceInput() {
  const context = use(VoiceInputContext);
  if (!context) throw new Error("Voice input provider is missing.");
  return context;
}

function useVoiceInputRuntime() {
  const registry = use(RegistryContext);
  const remoteContexts = useAtomValue(voiceRequestContextsAtom);
  const voiceGrant = useAtomValue(voiceGrantAtom);
  const grantedScope = useEnvironmentScope(
    voiceGrant?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const grantedConnection = usePreparedConnection(voiceGrant?.environmentId ?? null);
  useAtomMount(mobilePreferencesAtom);
  useAtomMount(updateMobilePreferencesAtom);
  const [{ state, ownerKey, label }, setState] = useState({
    state: INITIAL_STATE,
    ownerKey: null as string | null,
    label: null as string | null,
  });
  const [focusedOwners, setFocusedOwners] = useState<ReadonlySet<string>>(new Set());
  const setOwnerFocused = useCallback((key: string, focused: boolean) => {
    setFocusedOwners((current) => {
      const next = new Set(current);
      if (focused) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const keepAwakeId = useId();
  const keepAwakeSessionRef = useRef(0);
  const elapsedSecondsRef = useRef(0);
  const [initialLevels] = useState(() => Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevelsRef = useRef(initialLevels);
  const audioLevels = useSharedValue(initialLevels);
  const audioToken = useRef<ReturnType<typeof acquireAudioSession> | null>(null);

  /* oxlint-disable react/refs -- The initializer captures the audio-session ref for later recording callbacks; it does not read it. */
  const [{ session, recorder }] = useState(() => {
    let session: VoiceInputSession | null = null;
    const recorder = createLazyVoiceRecorder({
      create: () => new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
      onStatus: (status: RecordingStatus) => {
        session?.controller.handleRecorderStatus({
          isFinished: status.isFinished,
          hasError: status.hasError || status.mediaServicesDidReset === true,
          error: status.error,
          url: status.url,
        });
      },
      // Read when recording starts so preference changes do not re-render every composer.
      selectInput: (inputs) => {
        const preferences = registry.get(mobilePreferencesAtom);
        if (!AsyncResult.isSuccess(preferences)) return null;
        const known = microphoneOrder(preferences.value.microphones);
        const order = rememberMicrophones(known, inputs);
        if (order !== known) {
          registry.set(updateMobilePreferencesAtom, {
            transform: (current) => ({
              microphones: rememberMicrophones(microphoneOrder(current.microphones), inputs),
            }),
          });
        }
        return preferredMicrophoneInput(inputs, order);
      },
    });
    session = new VoiceInputSession({
      recorder,
      getTranscriber: () => {
        const grant = registry.get(voiceGrantAtom);
        if (grant === undefined) return null;
        if (grant !== null) {
          if (Platform.OS !== "ios") return null;
          const canSend = () => {
            const current = registry.get(voiceGrantAtom);
            const context = registry.get(voiceRequestContextsAtom).get(grant.environmentId);
            return (
              current?.id === grant.id &&
              current.environmentId === grant.environmentId &&
              context !== undefined &&
              context.prepared.target._tag !== "HubProxyConnectionTarget" &&
              sessionHasScope(
                registry.get(environmentSession.sessionStateAtom(grant.environmentId)),
                AuthOrchestrationOperateScope,
              )
            );
          };
          return createEnvironmentWavTranscriber({
            environmentId: grant.environmentId,
            locale: Intl.DateTimeFormat().resolvedOptions().locale,
            canSend,
            resolveContext: () =>
              registry.get(voiceRequestContextsAtom).get(grant.environmentId) ?? null,
            readAudio: async (uri, signal) => {
              throwIfVoiceTranscriptionAborted(signal);
              const file = new File(uri);
              if (file.size === null || file.size > VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES)
                throw new VoiceTranscriptionError(
                  "transcription-failed",
                  "The voice recording is too large or unavailable.",
                );
              return file.bytes();
            },
            upload: async (context, audio, signal, canSendAudio) =>
              (
                await runMobileSpeechRequest(
                  transcribeLocalModelEffect(context, audio, canSendAudio),
                  signal,
                )
              ).text,
          });
        }
        const target = session?.currentTarget;
        const environmentId = target?.environmentId;
        const remote =
          Platform.OS === "ios" && environmentId
            ? createRemoteVoiceTranscriber({
                locale: Intl.DateTimeFormat().resolvedOptions().locale,
                providerInstanceId: target.providerInstanceId,
                cwd: target.cwd,
                threadId: target.threadId,
                resolveContext: () =>
                  registry.get(voiceRequestContextsAtom).get(environmentId) ?? null,
                readAudioBytes: async (uri, signal) => {
                  throwIfVoiceTranscriptionAborted(signal);
                  const bytes = await new File(uri).bytes();
                  throwIfVoiceTranscriptionAborted(signal);
                  return bytes;
                },
              })
            : null;
        return getVoiceTranscriber(remote);
      },
      requestPermission: async () => {
        const permission = await requestRecordingPermissionsAsync();
        return { granted: permission.granted, canAskAgain: permission.canAskAgain };
      },
      configureRecording: async () => {
        const token = acquireAudioSession("recording");
        audioToken.current = token;
        try {
          await activateAudioSession(token);
        } catch (error) {
          await releaseAudioSession(token).catch(() => {});
          throw error;
        }
      },
      releaseRecording: async () => {
        if (audioToken.current) await releaseAudioSession(audioToken.current);
        audioToken.current = null;
      },
      deleteRecording: (uri) => new File(uri).delete(),
      onStateChange: (nextState) =>
        setState({
          state: nextState,
          ownerKey: session?.ownerKey ?? null,
          label: session?.label ?? null,
        }),
    });
    return { session, recorder };
  });
  /* oxlint-enable react/refs */

  const controller = session.controller;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // iOS permission dialogs report inactive; cancel preparation only on background. Recorder status handles capture interruptions.
      if (nextState === "background") controller.appMovedToBackground();
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(
    () => () => {
      controller.dispose();
      recorder.release();
    },
    [controller, recorder],
  );

  useEffect(() => {
    if (state.phase !== "recording") return;

    const tag = `voice-input:${keepAwakeId}:${++keepAwakeSessionRef.current}`;
    const activation = activateKeepAwakeAsync(tag);
    void activation.catch(() => {});
    return () => {
      // Release after activation settles, even if the recording ends immediately.
      void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
    };
  }, [keepAwakeId, state.phase]);

  useEffect(() => {
    if (state.phase !== "preparing" && state.phase !== "recording") return;

    if (audioLevelsRef.current.some((level) => level !== 0)) {
      audioLevelsRef.current = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
      audioLevels.set(audioLevelsRef.current);
    }
    if (elapsedSecondsRef.current !== 0) {
      elapsedSecondsRef.current = 0;
      setElapsedSeconds(0);
    }
    if (state.phase !== "recording") return;

    const sampleRecording = () => {
      if (controller.currentState.phase !== "recording") return;
      const status = recorder.getStatus();
      if (!status?.isRecording) return;

      const level = normalizeVoiceInputDecibels(status.metering);
      const history = audioLevelsRef.current;
      if (level !== 0 || history.some((sample) => sample !== 0)) {
        const nextLevels = [...history.slice(1), level];
        audioLevelsRef.current = nextLevels;
        audioLevels.set(nextLevels);
      }

      const nextElapsedSeconds = Math.min(
        VOICE_RECORDING_LIMIT_SECONDS,
        Math.max(0, Math.floor(status.durationMillis / 1_000)),
      );
      if (nextElapsedSeconds !== elapsedSecondsRef.current) {
        elapsedSecondsRef.current = nextElapsedSeconds;
        setElapsedSeconds(nextElapsedSeconds);
      }
    };

    sampleRecording();
    const intervalId = setInterval(sampleRecording, VOICE_METERING_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [audioLevels, controller, recorder, state.phase]);

  const stop = useCallback(() => controller.stop(), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);
  const localAvailable = getLocalVoiceTranscriber() !== null || getNativeShowcaseScene() !== null;
  const selectedAvailable =
    voiceGrant !== null &&
    voiceGrant !== undefined &&
    Platform.OS === "ios" &&
    grantedScope &&
    Option.isSome(grantedConnection) &&
    grantedConnection.value.target._tag !== "HubProxyConnectionTarget" &&
    remoteContexts.has(voiceGrant.environmentId);
  const grantIdentity = voiceGrant === undefined ? "loading" : (voiceGrant?.id ?? "device");
  const previousGrant = useRef({ identity: grantIdentity, available: selectedAvailable });
  // oxlint-disable-next-line goat/react-effect-budget -- Stop microphone and network work when consent or its connection changes.
  useEffect(() => {
    const previous = previousGrant.current;
    previousGrant.current = { identity: grantIdentity, available: selectedAvailable };
    if (previous.identity !== grantIdentity || (previous.available && !selectedAvailable))
      controller.cancel();
  }, [controller, grantIdentity, selectedAvailable]);
  const isAvailableForEnvironment = (environmentId: EnvironmentId | null) =>
    voiceGrant === undefined
      ? false
      : voiceGrant !== null
        ? selectedAvailable
        : localAvailable ||
          (Platform.OS === "ios" && environmentId !== null && remoteContexts.has(environmentId));

  return {
    isAvailable:
      voiceGrant === undefined
        ? false
        : voiceGrant !== null
          ? selectedAvailable
          : localAvailable || (Platform.OS === "ios" && remoteContexts.size > 0),
    isAvailableForEnvironment,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    ownerKey,
    label,
    focusedOwners,
    setOwnerFocused,
    session,
    stop,
    cancel,
  };
}

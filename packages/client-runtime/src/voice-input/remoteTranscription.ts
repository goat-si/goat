import {
  VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ,
  type ProviderInstanceId,
  type ThreadId,
  type VoicePrewarmInput,
  type VoicePrewarmResult,
  type VoiceTranscriptionInput,
  type VoiceTranscriptionResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "./transcription.ts";
import { uint8ArrayToBase64, validateCanonicalVoiceWav } from "./wavEncoding.ts";

const VOICE_TRANSCRIBE_TIMEOUT_MS = 120_000;
const VOICE_PREWARM_TIMEOUT_MS = 10_000;

export interface EnvironmentVoiceRequestContext {
  readonly prepared: PreparedConnection;
  readonly signer?: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
}

export function transcribeEnvironmentVoiceEffect(
  context: EnvironmentVoiceRequestContext,
  payload: VoiceTranscriptionInput,
  timeoutMs: number = VOICE_TRANSCRIBE_TIMEOUT_MS,
) {
  return executeAuthenticatedEnvironmentHttpRequest({
    prepared: context.prepared,
    signer: context.signer ?? Option.none(),
    ...(context.remoteAuthorization ? { remoteAuthorization: context.remoteAuthorization } : {}),
    method: "POST",
    group: "voice",
    timeoutMs,
    url: (urls) => urls.transcribe(),
    request: ({ client, headers }) => client.transcribe({ headers, payload }),
  });
}

export function prewarmEnvironmentVoiceEffect(
  context: EnvironmentVoiceRequestContext,
  payload: VoicePrewarmInput,
  timeoutMs: number = VOICE_PREWARM_TIMEOUT_MS,
) {
  return executeAuthenticatedEnvironmentHttpRequest({
    prepared: context.prepared,
    signer: context.signer ?? Option.none(),
    ...(context.remoteAuthorization ? { remoteAuthorization: context.remoteAuthorization } : {}),
    method: "POST",
    group: "voice",
    timeoutMs,
    url: (urls) => urls.prewarm(),
    request: ({ client, headers }) => client.prewarm({ headers, payload }),
  });
}

const getGlobalFetch = (): typeof globalThis.fetch => Reflect.get(globalThis, "fetch");
const defaultRemoteHttpClientLayer = layerRemoteHttpClient((input, init) =>
  getGlobalFetch()(input, init),
);

export async function transcribeEnvironmentVoice(
  context: EnvironmentVoiceRequestContext,
  payload: VoiceTranscriptionInput,
  options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
): Promise<VoiceTranscriptionResult> {
  return Effect.runPromise(
    transcribeEnvironmentVoiceEffect(context, payload, options?.timeoutMs).pipe(
      Effect.provide(defaultRemoteHttpClientLayer),
    ),
    options?.signal ? { signal: options.signal } : undefined,
  );
}

export async function prewarmEnvironmentVoice(
  context: EnvironmentVoiceRequestContext,
  payload: VoicePrewarmInput,
  options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
): Promise<VoicePrewarmResult> {
  return Effect.runPromise(
    prewarmEnvironmentVoiceEffect(context, payload, options?.timeoutMs).pipe(
      Effect.provide(defaultRemoteHttpClientLayer),
    ),
    options?.signal ? { signal: options.signal } : undefined,
  );
}

export interface RemoteVoiceTranscriberOptions {
  readonly locale: string;
  readonly resolveContext: () => EnvironmentVoiceRequestContext | null;
  readonly readAudioBytes: (uri: string, signal: AbortSignal) => Promise<Uint8Array>;
  readonly providerInstanceId?: ProviderInstanceId | null;
  readonly cwd?: string | null;
  readonly threadId?: ThreadId | null;
}

export function createRemoteVoiceTranscriber(
  options: RemoteVoiceTranscriberOptions,
): VoiceTranscriber {
  const pinnedProviderInstanceId = options.providerInstanceId ?? undefined;
  const pinnedCwd = options.cwd ?? undefined;
  const pinnedThreadId = options.threadId ?? undefined;
  const locale = options.locale;

  return {
    prepare: async ({ signal }: VoiceTranscriptionOptions): Promise<PreparedVoiceTranscription> => {
      throwIfVoiceTranscriptionAborted(signal);
      const initialContext = options.resolveContext();
      if (!initialContext) {
        throw new VoiceTranscriptionError(
          "unavailable",
          "Connect to an environment before using remote voice transcription.",
        );
      }
      void prewarmEnvironmentVoice(
        initialContext,
        {
          ...(pinnedProviderInstanceId ? { providerInstanceId: pinnedProviderInstanceId } : {}),
          ...(pinnedCwd ? { cwd: pinnedCwd } : {}),
          ...(pinnedThreadId ? { threadId: pinnedThreadId } : {}),
        },
        { signal },
      ).catch(() => undefined);
      throwIfVoiceTranscriptionAborted(signal);

      return {
        locale,
        transcribe: async (
          uri: string,
          transcribeOptions: VoiceTranscriptionOptions,
        ): Promise<string> => {
          throwIfVoiceTranscriptionAborted(transcribeOptions.signal);
          const currentContext = options.resolveContext();
          if (!currentContext) {
            throw new VoiceTranscriptionError(
              "unavailable",
              "Voice transcription lost its connection to the environment.",
            );
          }
          try {
            const bytes = await options.readAudioBytes(uri, transcribeOptions.signal);
            throwIfVoiceTranscriptionAborted(transcribeOptions.signal);
            const validated = validateCanonicalVoiceWav(bytes);
            if (!validated.ok) {
              throw new VoiceTranscriptionError("transcription-failed", validated.reason);
            }
            const audioBase64 = uint8ArrayToBase64(validated.value.bytes);
            const result = await transcribeEnvironmentVoice(
              currentContext,
              {
                audioBase64,
                mimeType: "audio/wav",
                sampleRateHz: VOICE_TRANSCRIPTION_SAMPLE_RATE_HZ,
                durationMs: validated.value.sampleDurationMs,
                locale,
                ...(pinnedProviderInstanceId
                  ? { providerInstanceId: pinnedProviderInstanceId }
                  : {}),
                ...(pinnedCwd ? { cwd: pinnedCwd } : {}),
                ...(pinnedThreadId ? { threadId: pinnedThreadId } : {}),
              },
              { signal: transcribeOptions.signal },
            );
            throwIfVoiceTranscriptionAborted(transcribeOptions.signal);
            return result.text.trim();
          } catch (error) {
            throwIfVoiceTranscriptionAborted(transcribeOptions.signal);
            if (error instanceof VoiceTranscriptionError) {
              throw error;
            }
            throw new VoiceTranscriptionError(
              "transcription-failed",
              error instanceof Error ? error.message : "Voice transcription failed.",
              { cause: error },
            );
          }
        },
      };
    },
  };
}

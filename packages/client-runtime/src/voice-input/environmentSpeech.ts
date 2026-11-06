import type { SpeechConfiguration, VoiceTranscriptionInput } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { EnvironmentVoiceRequestContext } from "./remoteTranscription.ts";
import {
  layerRemoteHttpClient,
  makeEnvironmentHttpApiGroupClient,
  makeEnvironmentHttpApiUrlBuilder,
} from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpAuth.ts";

type SpeechClient = Effect.Success<
  ReturnType<typeof makeEnvironmentHttpApiGroupClient<"environmentSpeech">>
>;
type SpeechUrls = ReturnType<typeof makeEnvironmentHttpApiUrlBuilder>["environmentSpeech"];

const request = <A, E>(input: {
  context: EnvironmentVoiceRequestContext;
  method: "GET" | "POST";
  path: (urls: SpeechUrls) => string;
  run: (
    client: SpeechClient,
    headers: { readonly authorization?: string; readonly dpop?: string },
  ) => Effect.Effect<A, E>;
  canSend?: () => boolean;
  timeoutMs?: number;
}) =>
  executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.context.prepared,
    signer: input.context.signer ?? Option.none(),
    ...(input.context.remoteAuthorization
      ? { remoteAuthorization: input.context.remoteAuthorization }
      : {}),
    method: input.method,
    group: "environmentSpeech",
    timeoutMs: input.timeoutMs ?? 30_000,
    requestInit: { redirect: "error" },
    url: input.path,
    request: ({ client, headers }) =>
      Effect.suspend(() =>
        input.canSend?.() === false ? Effect.interrupt : input.run(client, headers),
      ),
  });

export const transcribeLocalModelEffect = (
  context: EnvironmentVoiceRequestContext,
  payload: VoiceTranscriptionInput,
  canSend: () => boolean,
) =>
  request({
    context,
    method: "POST",
    path: (urls) => urls.transcribe(),
    run: (client, headers) => client.transcribe({ headers, payload }),
    canSend,
    timeoutMs: 120_000,
  });

export const listEnvironmentSpeechModelsEffect = (context: EnvironmentVoiceRequestContext) =>
  request({
    context,
    method: "GET",
    path: (urls) => urls.models(),
    run: (client, headers) => client.models({ headers }),
  });
export const getEnvironmentSpeechConfigurationEffect = (context: EnvironmentVoiceRequestContext) =>
  request({
    context,
    method: "GET",
    path: (urls) => urls.configuration(),
    run: (client, headers) => client.configuration({ headers }),
  });
export const downloadEnvironmentSpeechModelEffect = (
  context: EnvironmentVoiceRequestContext,
  modelId: string,
) =>
  request({
    context,
    method: "POST",
    path: (urls) => urls.download(),
    run: (client, headers) => client.download({ headers, payload: { modelId } }),
    timeoutMs: 30 * 60_000,
  });
export const removeEnvironmentSpeechModelEffect = (
  context: EnvironmentVoiceRequestContext,
  modelId: string,
) =>
  request({
    context,
    method: "POST",
    path: (urls) => urls.remove(),
    run: (client, headers) => client.remove({ headers, payload: { modelId } }),
  });
export const configureEnvironmentSpeechEffect = (
  context: EnvironmentVoiceRequestContext,
  payload: SpeechConfiguration,
) =>
  request({
    context,
    method: "POST",
    path: (urls) => urls.configure(),
    run: (client, headers) => client.configure({ headers, payload }),
  });

const getGlobalFetch = (): typeof globalThis.fetch => Reflect.get(globalThis, "fetch");
const http = layerRemoteHttpClient((input, init) => getGlobalFetch()(input, init));
export function transcribeLocalModel(
  context: EnvironmentVoiceRequestContext,
  payload: VoiceTranscriptionInput,
  options: { signal: AbortSignal; canSend: () => boolean },
) {
  return Effect.runPromise(
    transcribeLocalModelEffect(context, payload, options.canSend).pipe(Effect.provide(http)),
    { signal: options.signal },
  );
}

export const listEnvironmentSpeechModels = (
  context: EnvironmentVoiceRequestContext,
  signal?: AbortSignal,
) =>
  Effect.runPromise(
    listEnvironmentSpeechModelsEffect(context).pipe(Effect.provide(http)),
    signal ? { signal } : undefined,
  );
export const getEnvironmentSpeechConfiguration = (
  context: EnvironmentVoiceRequestContext,
  signal?: AbortSignal,
) =>
  Effect.runPromise(
    getEnvironmentSpeechConfigurationEffect(context).pipe(Effect.provide(http)),
    signal ? { signal } : undefined,
  );
export const downloadEnvironmentSpeechModel = (
  context: EnvironmentVoiceRequestContext,
  modelId: string,
  signal?: AbortSignal,
) =>
  Effect.runPromise(
    downloadEnvironmentSpeechModelEffect(context, modelId).pipe(Effect.provide(http)),
    signal ? { signal } : undefined,
  );
export const removeEnvironmentSpeechModel = (
  context: EnvironmentVoiceRequestContext,
  modelId: string,
  signal?: AbortSignal,
) =>
  Effect.runPromise(
    removeEnvironmentSpeechModelEffect(context, modelId).pipe(Effect.provide(http)),
    signal ? { signal } : undefined,
  );
export const configureEnvironmentSpeech = (
  context: EnvironmentVoiceRequestContext,
  config: SpeechConfiguration,
  signal?: AbortSignal,
) =>
  Effect.runPromise(
    configureEnvironmentSpeechEffect(context, config).pipe(Effect.provide(http)),
    signal ? { signal } : undefined,
  );

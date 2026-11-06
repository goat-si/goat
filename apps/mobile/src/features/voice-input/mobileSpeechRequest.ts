import { layerRemoteHttpClient } from "@goat/client-runtime/rpc";
import { fetch as expoFetch } from "expo/fetch";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";

const http = layerRemoteHttpClient((url, init) => expoFetch(url, { ...init, redirect: "error" }));
export function runMobileSpeechRequest<A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  signal: AbortSignal,
) {
  return Effect.runPromise(effect.pipe(Effect.provide(http)), { signal });
}

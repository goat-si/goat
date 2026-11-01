import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";

/**
 * Where a recording is transcribed. The desktop app always transcribes on its own machine with
 * that machine's sign-in, so a thread on another machine never receives this device's audio.
 */
export type VoiceTranscriptionRoute =
  | { readonly kind: "local"; readonly environmentId: EnvironmentId }
  | { readonly kind: "unavailable" }
  | { readonly kind: "environment"; readonly environmentId: EnvironmentId };

export type VoiceTranscriptionLocation =
  | { readonly kind: "this-device" }
  | {
      readonly kind: "environment";
      readonly environmentId: EnvironmentId;
      readonly label: string;
    };

export function resolveVoiceTranscriptionRoute(input: {
  /** The client runs beside its own GOAT server (desktop). */
  readonly requiresLocalRuntime: boolean;
  /** That server, when it is running. */
  readonly localEnvironmentId: EnvironmentId | null;
  readonly threadEnvironmentId: EnvironmentId;
}): VoiceTranscriptionRoute {
  if (!input.requiresLocalRuntime)
    return { kind: "environment", environmentId: input.threadEnvironmentId };
  return input.localEnvironmentId
    ? { kind: "local", environmentId: input.localEnvironmentId }
    : { kind: "unavailable" };
}

interface VoiceThreadContext {
  readonly threadId: ThreadId | null;
  readonly cwd: string | null;
  readonly providerInstanceId: ProviderInstanceId | null;
}

/**
 * The thread's identity only means something to the server that owns the thread.
 * Null when there is nowhere to send the audio.
 */
export function voiceTranscriptionRequest(
  route: VoiceTranscriptionRoute,
  thread: VoiceThreadContext,
) {
  if (route.kind === "unavailable") return null;
  if (route.kind === "local") return { environmentId: route.environmentId, routing: {} };
  return {
    environmentId: route.environmentId,
    routing: {
      ...(thread.threadId ? { threadId: thread.threadId } : {}),
      ...(thread.cwd ? { cwd: thread.cwd } : {}),
      ...(thread.providerInstanceId ? { providerInstanceId: thread.providerInstanceId } : {}),
    },
  };
}

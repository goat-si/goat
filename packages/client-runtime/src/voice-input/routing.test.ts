import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { resolveVoiceTranscriptionRoute, voiceTranscriptionRequest } from "./routing.ts";

const local = EnvironmentId.make("this-mac");
const remote = EnvironmentId.make("build-box");
const thread = {
  threadId: ThreadId.make("thread-on-build-box"),
  cwd: "/srv/project",
  providerInstanceId: ProviderInstanceId.make("codex-work"),
};

describe("voice transcription routing", () => {
  it("keeps desktop audio on this device even for a thread on another machine", () => {
    const route = resolveVoiceTranscriptionRoute({
      requiresLocalRuntime: true,
      localEnvironmentId: local,
      threadEnvironmentId: remote,
    });
    expect(route).toEqual({ kind: "local", environmentId: local });
    // Prewarm, previews and the final clip share this request: the remote thread's identity never
    // reaches this device's server, which uses its own Codex sign-in.
    expect(voiceTranscriptionRequest(route, thread)).toEqual({ environmentId: local, routing: {} });
  });

  it("refuses desktop voice input when this device runs no local environment", () => {
    const route = resolveVoiceTranscriptionRoute({
      requiresLocalRuntime: true,
      localEnvironmentId: null,
      threadEnvironmentId: remote,
    });
    expect(route).toEqual({ kind: "unavailable" });
    expect(voiceTranscriptionRequest(route, thread)).toBeNull();
  });

  it("sends browser and phone audio to the environment they are connected to", () => {
    const route = resolveVoiceTranscriptionRoute({
      requiresLocalRuntime: false,
      localEnvironmentId: local,
      threadEnvironmentId: remote,
    });
    expect(route).toEqual({ kind: "environment", environmentId: remote });
    expect(voiceTranscriptionRequest(route, thread)).toEqual({
      environmentId: remote,
      routing: thread,
    });
    expect(
      voiceTranscriptionRequest(route, { threadId: null, cwd: null, providerInstanceId: null }),
    ).toEqual({
      environmentId: remote,
      routing: {},
    });
  });
});

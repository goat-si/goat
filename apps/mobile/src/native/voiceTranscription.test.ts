import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createRemoteVoiceTranscriber,
  encodeMonoPcm16Wav,
  validateCanonicalVoiceWav,
  VoiceTranscriptionError,
  type VoiceTranscriber,
  type EnvironmentVoiceRequestContext,
} from "@goat/client-runtime/voice-input";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "@goat/client-runtime/connection";
import { RemoteEnvironmentAuthorization } from "@goat/client-runtime/authorization/service";
import { ManagedRelay } from "@goat/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const native = vi.hoisted(() => ({
  isAvailable: vi.fn<(locale: string) => boolean>(),
  prepare: vi.fn<(locale: string) => Promise<string>>(),
  transcribe: vi.fn(),
  readAudio: vi.fn<() => Promise<ArrayBuffer>>(),
}));

vi.mock("@react-native-ai/apple/src/NativeAppleTranscription", () => ({
  default: {
    isAvailable: native.isAvailable,
    prepare: native.prepare,
    transcribe: native.transcribe,
  },
}));
vi.mock("expo-file-system", () => ({
  File: class {
    arrayBuffer = native.readAudio;
  },
}));

import { getVoiceTranscriber } from "./voiceTranscription.ios";
import { getVoiceTranscriber as getAndroidVoiceTranscriber } from "./voiceTranscription";
import {
  createVoiceInputTarget,
  VoiceInputSession,
} from "../features/voice-input/voiceInputSession";
import { resetVoiceInputGlobalsForTests } from "../../../../packages/client-runtime/src/voice-input/controller";

function options() {
  return { signal: new AbortController().signal };
}

function remoteStub() {
  const transcribe = vi.fn(async () => "remote words");
  const prepare = vi.fn(async () => ({ locale: "en-US", transcribe }));
  return { prepare, transcribe };
}

function preparedConnection(environmentId: EnvironmentId): PreparedConnection {
  const httpBaseUrl = `https://${environmentId}.example.test`;
  return {
    environmentId,
    label: environmentId,
    httpBaseUrl,
    socketUrl: httpBaseUrl.replace("https:", "wss:") + "/ws",
    httpAuthorization: { _tag: "Bearer", token: "test-voice-token" },
    target: new PrimaryConnectionTarget({
      environmentId,
      label: environmentId,
      httpBaseUrl,
      wsBaseUrl: httpBaseUrl.replace("https:", "wss:"),
    }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  resetVoiceInputGlobalsForTests();
  native.isAvailable.mockReturnValue(true);
  native.prepare.mockResolvedValue("en-US");
  native.readAudio.mockResolvedValue(new ArrayBuffer(8));
  native.transcribe.mockResolvedValue({ segments: [{ text: "local words" }] });
});

describe("iOS voice transcription selection", () => {
  it("prefers local Apple transcription when supported", async () => {
    const remote = remoteStub();
    const request = options();
    const prepared = await getVoiceTranscriber(remote)!.prepare(request);
    await expect(prepared.transcribe("file:///voice.wav", request)).resolves.toBe("local words");
    expect(remote.prepare).not.toHaveBeenCalled();
    expect(remote.transcribe).not.toHaveBeenCalled();
  });

  it("selects remote transcription on devices without Apple transcription", async () => {
    native.isAvailable.mockReturnValue(false);
    const remote = remoteStub();
    const request = options();
    const prepared = await getVoiceTranscriber(remote)!.prepare(request);
    await expect(prepared.transcribe("file:///voice.wav", request)).resolves.toBe("remote words");
    expect(native.prepare).not.toHaveBeenCalled();
    expect(native.transcribe).not.toHaveBeenCalled();
  });

  it.each([
    { code: "AppleTranscriptionUnsupportedLocale" },
    { code: "AppleTranscriptionUnavailable" },
    new VoiceTranscriptionError("unsupported-locale", "unsupported language"),
    new VoiceTranscriptionError("unavailable", "unavailable device"),
  ])("falls back only for unavailable or unsupported preparation: %j", async (error) => {
    native.prepare.mockRejectedValue(error);
    const remote = remoteStub();
    const request = options();
    const prepared = await getVoiceTranscriber(remote)!.prepare(request);
    await expect(prepared.transcribe("file:///voice.wav", request)).resolves.toBe("remote words");
    expect(remote.prepare).toHaveBeenCalledWith(request);
  });

  it("handles local availability disappearing before preparation", async () => {
    native.isAvailable.mockReturnValueOnce(true).mockReturnValue(false);
    const remote = remoteStub();
    await getVoiceTranscriber(remote)!.prepare(options());
    expect(native.prepare).not.toHaveBeenCalled();
    expect(remote.prepare).toHaveBeenCalledOnce();
  });

  it.each([
    { code: "permission-denied" },
    { code: "AppleTranscription", message: "native asset download failed" },
    new VoiceTranscriptionError("cancelled", "cancelled"),
    new Error("unexpected native error"),
  ])(
    "never falls back after denied, canceled, or arbitrary preparation errors: %j",
    async (error) => {
      native.prepare.mockRejectedValue(error);
      const remote = remoteStub();
      await expect(getVoiceTranscriber(remote)!.prepare(options())).rejects.toBeInstanceOf(
        VoiceTranscriptionError,
      );
      expect(remote.prepare).not.toHaveBeenCalled();
      expect(remote.transcribe).not.toHaveBeenCalled();
    },
  );

  it("does not fall back when canceled while unsupported preparation settles", async () => {
    const pending = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    native.prepare.mockImplementation(() => {
      entered.resolve();
      return pending.promise;
    });
    const remote = remoteStub();
    const controller = new AbortController();
    const result = getVoiceTranscriber(remote)!.prepare({ signal: controller.signal });
    await entered.promise;
    controller.abort();
    pending.reject({ code: "AppleTranscriptionUnsupportedLocale" });
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(remote.prepare).not.toHaveBeenCalled();
  });

  it("never falls back after recording when native transcription fails", async () => {
    native.transcribe.mockRejectedValue({ code: "AppleTranscriptionUnsupportedLocale" });
    const remote = remoteStub();
    const request = options();
    const prepared = await getVoiceTranscriber(remote)!.prepare(request);
    await expect(prepared.transcribe("file:///voice.wav", request)).rejects.toMatchObject({
      code: "transcription-failed",
    });
    expect(remote.prepare).not.toHaveBeenCalled();
    expect(remote.transcribe).not.toHaveBeenCalled();
  });

  it("returns null when neither local nor remote transcription exists", () => {
    native.isAvailable.mockReturnValue(false);
    expect(getVoiceTranscriber()).toBeNull();
  });

  it("never enables remote upload for Android M4A recordings", () => {
    const remote = remoteStub();
    expect(getAndroidVoiceTranscriber(remote)).toBeNull();
    expect(remote.prepare).not.toHaveBeenCalled();
  });
});

describe("mobile remote voice integration", () => {
  function sessionHarness(input: { granted?: boolean; bytes?: Uint8Array } = {}) {
    native.isAvailable.mockReturnValue(false);
    const environmentA = EnvironmentId.make("environment-a");
    const environmentB = EnvironmentId.make("environment-b");
    const contexts = new Map<EnvironmentId, EnvironmentVoiceRequestContext>([
      [environmentA, { prepared: preparedConnection(environmentA) }],
      [environmentB, { prepared: preparedConnection(environmentB) }],
    ]);
    const bytes =
      input.bytes ?? encodeMonoPcm16Wav([new Float32Array(24_000).fill(0.1)], 24_000)!.bytes;
    const readAudioBytes = vi.fn(async () => bytes);
    const commit = vi.fn();
    const recorder = {
      uri: "file:///voice.wav",
      prepareToRecordAsync: vi.fn(async () => {}),
      record: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    const session: VoiceInputSession = new VoiceInputSession({
      recorder,
      getTranscriber: (): VoiceTranscriber | null => {
        const target = session.currentTarget!;
        const environmentId = target.environmentId!;
        return getVoiceTranscriber(
          createRemoteVoiceTranscriber({
            locale: "en-US",
            providerInstanceId: target.providerInstanceId,
            cwd: target.cwd,
            threadId: target.threadId,
            resolveContext: () => contexts.get(environmentId) ?? null,
            readAudioBytes,
          }),
        );
      },
      requestPermission: async () => ({ granted: input.granted ?? true, canAskAgain: false }),
      configureRecording: async () => {},
      releaseRecording: async () => {},
      deleteRecording: vi.fn(),
      onStateChange: vi.fn(),
    });
    const target = (environmentId: EnvironmentId) =>
      createVoiceInputTarget(
        environmentId,
        () => "draft",
        commit,
        { start: 5, end: 5 },
        () => () => {},
        {
          environmentId,
          providerInstanceId: ProviderInstanceId.make("codex-a"),
          cwd: "/workspace/a",
          threadId: ThreadId.make("thread-a"),
        },
      );
    return {
      session,
      target,
      environmentA,
      environmentB,
      contexts,
      bytes,
      recorder,
      readAudioBytes,
      commit,
    };
  }

  it("sends canonical WAV to the starting environment with fresh credentials after navigation", async () => {
    const harness = sessionHarness();
    const requests: Array<{ url: string; headers: Headers; body: string }> = [];
    using fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return String(url).endsWith("/prewarm")
        ? Response.json({ ready: true })
        : Response.json({ text: "remote words" });
    });
    await harness.session.start(harness.target(harness.environmentA));
    await harness.session.start(harness.target(harness.environmentB));
    harness.contexts.set(harness.environmentA, {
      prepared: {
        ...preparedConnection(harness.environmentA),
        httpAuthorization: { _tag: "Bearer", token: "renewed-token" },
      },
    });
    await harness.session.controller.stop();
    const transcribeRequests = requests.filter((request) => request.url.endsWith("/transcribe"));
    expect(transcribeRequests).toHaveLength(1);
    const request = transcribeRequests[0]!;
    expect(request.url).toBe("https://environment-a.example.test/api/voice/transcribe");
    expect(request.headers.get("Authorization")).toBe("Bearer renewed-token");
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1000,
      providerInstanceId: "codex-a",
      cwd: "/workspace/a",
      threadId: "thread-a",
    });
    expect(
      validateCanonicalVoiceWav(
        new Uint8Array(Buffer.from(body.audioBase64, "base64")),
        body.durationMs,
      ).ok,
    ).toBe(true);
    expect(harness.commit).toHaveBeenCalledWith("draft remote words", { start: 18, end: 18 });
    expect(fetchMock).toHaveBeenCalled();
    expect(native.transcribe).not.toHaveBeenCalled();
  });

  it("renews DPoP credentials and retries a rejected token for environment A after navigation", async () => {
    const harness = sessionHarness();
    const authorizations: Array<{
      expectedEnvironmentId: EnvironmentId;
      rejectedAccessToken?: string;
    }> = [];
    const remoteAuthorization = RemoteEnvironmentAuthorization.of({
      authorizeBearer: () => Effect.die("unexpected bearer authorization"),
      authorizeDpop: () => Effect.die("unexpected socket authorization"),
      authorizeDpopHttp: (input) =>
        Effect.sync(() => {
          authorizations.push(input);
          const rejected = input.rejectedAccessToken !== undefined;
          return {
            environmentId: harness.environmentA,
            label: "Environment A",
            httpBaseUrl: rejected
              ? "https://renewed-a.example.test"
              : "https://current-a.example.test",
            httpAuthorization: {
              _tag: "Dpop" as const,
              accessToken: rejected ? "renewed-token" : "current-token",
              expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
            },
          };
        }),
    });
    const signer = ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("test-thumbprint"),
      createProof: () => Effect.succeed("test-proof"),
    });
    harness.contexts.set(harness.environmentA, {
      prepared: {
        ...preparedConnection(harness.environmentA),
        target: new RelayConnectionTarget({
          environmentId: harness.environmentA,
          label: "Environment A",
        }),
        httpAuthorization: { _tag: "Dpop", accessToken: "expired-token", expiresAtEpochMs: 0 },
      },
      signer: Option.some(signer),
      remoteAuthorization: Option.some(remoteAuthorization),
    });
    const uploads: Array<{ url: string; authorization: string | null }> = [];
    using fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("/prewarm")) return Response.json({ ready: true });
      uploads.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return uploads.length === 1
        ? Response.json(
            {
              _tag: "EnvironmentAuthInvalidError",
              code: "auth_invalid",
              reason: "invalid_credential",
              traceId: "test-rejected",
            },
            { status: 401 },
          )
        : Response.json({ text: "remote words" });
    });
    await harness.session.start(harness.target(harness.environmentA));
    await harness.session.start(harness.target(harness.environmentB));
    await harness.session.controller.stop();
    expect(uploads).toEqual([
      {
        url: "https://current-a.example.test/api/voice/transcribe",
        authorization: "DPoP current-token",
      },
      {
        url: "https://renewed-a.example.test/api/voice/transcribe",
        authorization: "DPoP renewed-token",
      },
    ]);
    expect(
      authorizations.every((input) => input.expectedEnvironmentId === harness.environmentA),
    ).toBe(true);
    expect(authorizations.filter((input) => input.rejectedAccessToken !== undefined)).toEqual([
      { expectedEnvironmentId: harness.environmentA, rejectedAccessToken: "current-token" },
    ]);
    expect(harness.commit).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("never prepares or uploads remotely when microphone permission is denied", async () => {
    using fetchMock = vi.spyOn(globalThis, "fetch");
    const harness = sessionHarness({ granted: false });
    await harness.session.start(harness.target(harness.environmentA));
    expect(harness.session.controller.currentState.errorAction).toBe("settings");
    expect(harness.recorder.record).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discards a canceled recording without uploading audio", async () => {
    using fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ready: true }));
    const harness = sessionHarness();
    await harness.session.start(harness.target(harness.environmentA));
    harness.session.controller.cancel();
    await harness.session.controller.stop();
    expect(harness.readAudioBytes).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/prewarm"))).toBe(true);
    expect(harness.commit).not.toHaveBeenCalled();
  });

  it("rejects compressed audio before remote transcription", async () => {
    using fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ready: true }));
    const harness = sessionHarness({ bytes: new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112]) });
    await harness.session.start(harness.target(harness.environmentA));
    await harness.session.controller.stop();
    expect(harness.session.controller.currentState.phase).toBe("error");
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/prewarm"))).toBe(true);
    expect(harness.commit).not.toHaveBeenCalled();
  });
});

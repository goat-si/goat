import { describe, expect, it, vi } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { RelayConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner, type ManagedRelayDpopProofInput } from "../relay/managedRelay.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import {
  createRemoteVoiceTranscriber,
  prewarmEnvironmentVoiceEffect,
  transcribeEnvironmentVoiceEffect,
} from "./remoteTranscription.ts";
import {
  base64ToUint8Array,
  encodeMonoPcm16Wav,
  uint8ArrayToBase64,
  validateCanonicalVoiceWav,
} from "./wavEncoding.ts";
import { VoiceTranscriptionError } from "./transcription.ts";

function wav() {
  return encodeMonoPcm16Wav([new Float32Array(24_000).fill(0.5)], 24_000)!;
}
function payload() {
  return {
    audioBase64: uint8ArrayToBase64(wav().bytes),
    mimeType: "audio/wav" as const,
    sampleRateHz: 24_000 as const,
    durationMs: 1_000,
  };
}
function harness(reply: (number: number) => Response = () => Response.json({ text: "draft" })) {
  const environmentId = EnvironmentId.make("environment-a");
  const prepared: PreparedConnection = {
    environmentId,
    label: "A",
    httpBaseUrl: "https://stale.test",
    socketUrl: "wss://stale.test/ws",
    httpAuthorization: {
      _tag: "Dpop",
      accessToken: "expired-while-recording",
      expiresAtEpochMs: 0,
    },
    target: new RelayConnectionTarget({ environmentId, label: "A" }),
  };
  const authorizations: Parameters<
    RemoteEnvironmentAuthorization["Service"]["authorizeDpopHttp"]
  >[0][] = [];
  const proofs: ManagedRelayDpopProofInput[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const authorization = RemoteEnvironmentAuthorization.of({
    authorizeBearer: () => Effect.die("Unexpected bearer authorization"),
    authorizeDpop: () => Effect.die("Unexpected WebSocket authorization"),
    authorizeDpopHttp: (input) =>
      Effect.sync(() => {
        authorizations.push(input);
        const rejected = input.rejectedAccessToken !== undefined;
        return {
          environmentId,
          label: "A",
          httpBaseUrl: `https://${rejected ? "renewed" : "current"}.test/hub/nodes/environment-a`,
          httpAuthorization: {
            _tag: "Dpop" as const,
            accessToken: rejected ? "renewed" : "current",
            expiresAtEpochMs: 3_600_000,
          },
        };
      }),
  });
  const signer = ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("thumbprint"),
    createProof: (input) =>
      Effect.sync(() => {
        proofs.push(input);
        return `proof-${proofs.length}`;
      }),
  });
  const fetchFn: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply(calls.length);
  };
  return {
    calls,
    proofs,
    authorizations,
    environmentId,
    fetchFn,
    layer: layerRemoteHttpClient(fetchFn),
    context: {
      prepared,
      signer: Option.some(signer),
      remoteAuthorization: Option.some(authorization),
    },
  };
}
const rejected = () =>
  Response.json(
    {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "test",
    },
    { status: 401 },
  );

describe("canonical WAV encoding and validation", () => {
  it("encodes clamped PCM16 and preserves duration over chunk boundaries", () => {
    const chunks = [Float32Array.of(-2, -0.5), Float32Array.of(0.5, 2)];
    const encoded = encodeMonoPcm16Wav(chunks, 24_000)!;
    const view = new DataView(encoded.bytes.buffer);
    expect([0, 1, 2, 3].map((index) => view.getInt16(44 + index * 2, true))).toEqual([
      -32768, -16384, 16384, 32767,
    ]);
    expect(validateCanonicalVoiceWav(encoded.bytes, encoded.durationMs).ok).toBe(true);
    expect(base64ToUint8Array(uint8ArrayToBase64(encoded.bytes))).toEqual(encoded.bytes);
  });

  it("interpolates through a chunk boundary identically to a contiguous input", () => {
    const samples = Float32Array.of(0, 0.25, 0.5, 0.75, 1, 0.5, 0, -0.5);
    const split = encodeMonoPcm16Wav(
      [samples.slice(0, 2), samples.slice(2, 5), samples.slice(5)],
      44_100,
    )!;
    expect(split.bytes).toEqual(encodeMonoPcm16Wav([samples], 44_100)!.bytes);
  });

  it.each([
    ["magic", (v: DataView) => v.setUint32(0, 0)],
    ["format", (v: DataView) => v.setUint16(20, 3, true)],
    ["stereo", (v: DataView) => v.setUint16(22, 2, true)],
    ["sample rate", (v: DataView) => v.setUint32(24, 16_000, true)],
    ["byte rate", (v: DataView) => v.setUint32(28, 32_000, true)],
    ["block alignment", (v: DataView) => v.setUint16(32, 4, true)],
    ["bit depth", (v: DataView) => v.setUint16(34, 8, true)],
    ["odd data", (v: DataView) => v.setUint32(40, 47_999, true)],
    ["empty data", (v: DataView) => v.setUint32(40, 0, true)],
  ] as const)("rejects invalid %s", (_, mutate) => {
    const bytes = wav().bytes;
    mutate(new DataView(bytes.buffer));
    expect(validateCanonicalVoiceWav(bytes).ok).toBe(false);
  });

  it("allows at most 250 ms of declared duration error", () => {
    const bytes = wav().bytes;
    expect(validateCanonicalVoiceWav(bytes, 1_250).ok).toBe(true);
    expect(validateCanonicalVoiceWav(bytes, 1_251).ok).toBe(false);
    expect(validateCanonicalVoiceWav(bytes, Number.NaN).ok).toBe(false);
    expect(base64ToUint8Array("!!!!")).toBeNull();
  });
});

describe("remote voice environment authorization", () => {
  it.effect.each(["transcribe", "prewarm"])(
    "renews current authorization and preserves the hub prefix for %s",
    (kind) =>
      Effect.gen(function* () {
        const h = harness(() =>
          Response.json(kind === "prewarm" ? { ready: true } : { text: "draft" }),
        );
        const effect =
          kind === "prewarm"
            ? prewarmEnvironmentVoiceEffect(h.context, {}).pipe(Effect.asVoid)
            : transcribeEnvironmentVoiceEffect(h.context, payload()).pipe(Effect.asVoid);
        yield* effect.pipe(Effect.provide(h.layer));
        expect(h.calls[0]!.url).toBe(
          `https://current.test/hub/nodes/environment-a/api/voice/${kind}`,
        );
        expect(new Headers(h.calls[0]!.init.headers).get("authorization")).toBe("DPoP current");
        expect(h.authorizations).toEqual([{ expectedEnvironmentId: h.environmentId }]);
        expect(h.proofs[0]!.url).toBe(h.calls[0]!.url);
      }),
  );

  it.effect("retries a rejected recording once with renewed relay URL, token, and proof", () =>
    Effect.gen(function* () {
      const h = harness((number) =>
        number === 1 ? rejected() : Response.json({ text: "renewed draft" }),
      );
      const result = yield* transcribeEnvironmentVoiceEffect(h.context, payload()).pipe(
        Effect.provide(h.layer),
      );
      expect(result.text).toBe("renewed draft");
      expect(h.authorizations).toEqual([
        { expectedEnvironmentId: h.environmentId },
        { expectedEnvironmentId: h.environmentId, rejectedAccessToken: "current" },
      ]);
      expect(h.calls.map((call) => call.url)).toEqual([
        "https://current.test/hub/nodes/environment-a/api/voice/transcribe",
        "https://renewed.test/hub/nodes/environment-a/api/voice/transcribe",
      ]);
      expect(h.proofs.map((proof) => proof.accessToken)).toEqual(["current", "renewed"]);
      expect(h.calls[0]!.init.body).toEqual(h.calls[1]!.init.body);
    }),
  );

  it.effect("stops after the renewed credential is also rejected", () =>
    Effect.gen(function* () {
      const h = harness(rejected);
      const error = yield* transcribeEnvironmentVoiceEffect(h.context, payload()).pipe(
        Effect.provide(h.layer),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "EnvironmentAuthInvalidError",
        reason: "invalid_credential",
      });
      expect(h.calls).toHaveLength(2);
      expect(h.authorizations).toHaveLength(2);
    }),
  );

  it.effect.each([
    "invalid-audio",
    "upstream-auth-expired",
    "upstream-rate-limited",
    "upstream-failed",
  ])("preserves server error code %s without credential retry", (code) =>
    Effect.gen(function* () {
      const h = harness(() =>
        Response.json(
          {
            _tag:
              code === "invalid-audio"
                ? "VoiceTranscriptionBadRequestError"
                : "VoiceTranscriptionUpstreamError",
            message: "Voice failed",
            code,
            retryable: false,
          },
          { status: code === "invalid-audio" ? 400 : 502 },
        ),
      );
      const error = yield* transcribeEnvironmentVoiceEffect(h.context, payload()).pipe(
        Effect.provide(h.layer),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "RemoteEnvironmentAuthFetchError",
        cause: { code, message: "Voice failed" },
      });
      expect(h.calls).toHaveLength(1);
    }),
  );

  it("uses a fresh context for the pinned environment at transcription and ignores prewarm failure", async () => {
    const h = harness(() => Response.json({ text: "  final draft  " }));
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).endsWith("prewarm")) return new Response("unavailable", { status: 503 });
      const input = JSON.parse(String(init?.body)) as { providerInstanceId?: string };
      if (input.providerInstanceId === "error-codex")
        return Response.json(
          {
            _tag: "VoiceTranscriptionUpstreamError",
            code: "upstream-auth-expired",
            retryable: false,
            message: "Sign in again.",
          },
          { status: 502 },
        );
      return h.fetchFn(url, init);
    });
    const controller = new AbortController();
    let currentContext = h.context;
    const resolveContext = vi.fn(() => currentContext);
    const transcriber = createRemoteVoiceTranscriber({
      locale: "ko-KR",
      resolveContext,
      readAudioBytes: async () => wav().bytes,
      providerInstanceId: ProviderInstanceId.make("selected-codex"),
      cwd: "/project",
      threadId: ThreadId.make("thread-a"),
    });
    const prepared = await transcriber.prepare({ signal: controller.signal });
    currentContext = {
      ...h.context,
      prepared: {
        ...h.context.prepared,
        httpBaseUrl: "https://latest.test/hub/nodes/environment-a",
        httpAuthorization: { _tag: "Bearer", token: "latest-token" },
      },
    };
    expect(await prepared.transcribe("clip.wav", { signal: controller.signal })).toBe(
      "final draft",
    );
    expect(resolveContext).toHaveBeenCalledTimes(2);
    expect(h.calls[0]!.url).toBe(
      "https://latest.test/hub/nodes/environment-a/api/voice/transcribe",
    );
    expect(new Headers(h.calls[0]!.init.headers).get("authorization")).toBe("Bearer latest-token");
    const body = JSON.parse(String(h.calls[0]!.init.body));
    expect(body).toMatchObject({
      providerInstanceId: "selected-codex",
      cwd: "/project",
      threadId: "thread-a",
      durationMs: 1_000,
    });
    expect(h.authorizations.every((input) => input.expectedEnvironmentId === h.environmentId)).toBe(
      true,
    );

    // Keep Promise-adapter requests in this fixture: Effect caches its default Fetch reference.
    const signal = controller.signal;
    const invalid = await createRemoteVoiceTranscriber({
      locale: "en",
      resolveContext: () => currentContext,
      readAudioBytes: async () => new Uint8Array(80),
    }).prepare({ signal });
    const uploadsBeforeInvalid = h.calls.length;
    await expect(invalid.transcribe("bad.wav", { signal })).rejects.toMatchObject({
      name: "VoiceTranscriptionError",
      code: "transcription-failed",
    });
    expect(h.calls).toHaveLength(uploadsBeforeInvalid);
    const rejected = await createRemoteVoiceTranscriber({
      locale: "en",
      providerInstanceId: ProviderInstanceId.make("error-codex"),
      resolveContext: () => currentContext,
      readAudioBytes: async () => wav().bytes,
    }).prepare({ signal });
    const error = await rejected
      .transcribe("clip.wav", { signal })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    if (!(error instanceof VoiceTranscriptionError)) throw new Error("Expected a voice failure");
    expect(error.code).toBe("transcription-failed");
    expect(error.message).toContain("Sign in again.");
    expect((error.cause as { cause: unknown }).cause).toMatchObject({
      code: "upstream-auth-expired",
      retryable: false,
    });
  });

  it("maps loss of connection and cancellation into stable voice errors", async () => {
    const transcriber = createRemoteVoiceTranscriber({
      locale: "en",
      resolveContext: () => null,
      readAudioBytes: async () => wav().bytes,
    });
    await expect(
      transcriber.prepare({ signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(VoiceTranscriptionError);
    await expect(transcriber.prepare({ signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "cancelled",
    });
  });
});

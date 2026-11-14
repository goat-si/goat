import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthFilesystemReadScope,
  AuthVoiceManageScope,
  DEFAULT_SPEECH_CONFIGURATION,
  encodeMonoPcm16Wav,
  uint8ArrayToBase64,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { Etag, HttpPlatform, HttpRouter } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as SpeechManagement from "./SpeechManagement.ts";
import * as SpeechHttp from "./http.ts";

class Api extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.environmentSpeech) {}

const serve = Effect.fn("test.speech.serve")(function* (
  scopes: readonly string[],
  transcription: Effect.Effect<string> = Effect.succeed("recognized"),
) {
  const list = vi.fn(() =>
    Effect.succeed([
      {
        id: "model",
        name: "Model",
        description: "Model",
        size: 1,
        installed: true,
        selected: true,
        benchmark: { cpu: null, accelerated: null },
        recommended: false,
        linkedFrom: "/private/model",
      },
    ]),
  );
  const download = vi.fn(() => Effect.void);
  const link = vi.fn(() => Effect.void);
  const remove = vi.fn(() => Effect.void);
  const configure = vi.fn(() => Effect.void);
  const transcribe = vi.fn(() => transcription);
  const service = Layer.succeed(SpeechManagement.SpeechManagement, {
    list: Effect.suspend(list),
    configuration: Effect.succeed(DEFAULT_SPEECH_CONFIGURATION),
    download,
    link,
    remove,
    configure,
    transcribe,
  });
  const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
    effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        scopes: new Set(scopes),
      } as unknown as EnvironmentAuthenticatedPrincipal["Service"]),
    ),
  );
  const app = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(SpeechHttp.layerHttp),
    Layer.provide(auth),
    Layer.provide(service),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(Etag.layerWeak),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  return {
    list,
    download,
    link,
    remove,
    configure,
    transcribe,
    send: (path: string, body?: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(
            `http://localhost/api/voice/environment/${path}`,
            body === undefined
              ? {}
              : {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(body),
                },
          ),
          Context.empty(),
        ),
      ),
  };
});

it.effect("rejects each management operation without voice:manage", () =>
  Effect.gen(function* () {
    const h = yield* serve([AuthOrchestrationOperateScope]);
    for (const [path, body] of [
      ["models", undefined],
      ["configure", undefined],
      ["models/download", { modelId: "model" }],
      ["models/link", { path: "/models" }],
      ["models/remove", { modelId: "model" }],
      ["configure", DEFAULT_SPEECH_CONFIGURATION],
    ] as const)
      expect((yield* h.send(path, body)).status).toBe(403);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.download).not.toHaveBeenCalled();
    expect(h.link).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.configure).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

it.effect("link requires filesystem read as well as voice management", () =>
  Effect.gen(function* () {
    const h = yield* serve([AuthVoiceManageScope]);
    const modelList = yield* h.send("models");
    expect(yield* Effect.promise(() => modelList.json())).not.toHaveProperty("models.0.linkedFrom");
    expect((yield* h.send("models/link", { path: "/models" })).status).toBe(403);
    expect(h.link).not.toHaveBeenCalled();
    const allowed = yield* serve([AuthVoiceManageScope, AuthFilesystemReadScope]);
    const allowedList = yield* allowed.send("models");
    expect(yield* Effect.promise(() => allowedList.json())).toHaveProperty(
      "models.0.linkedFrom",
      "/private/model",
    );
    expect((yield* allowed.send("models/link", { path: "/models" })).status).toBe(200);
    expect(allowed.link).toHaveBeenCalledWith("/models");
  }).pipe(Effect.scoped),
);

it.effect("requires orchestration:operate to transcribe", () =>
  Effect.gen(function* () {
    const h = yield* serve([AuthVoiceManageScope]);
    expect((yield* h.send("transcribe", {})).status).toBe(403);
    expect(h.transcribe).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

it.effect("admits one audio request before buffering the next", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<string>();
    const h = yield* serve(
      [AuthOrchestrationOperateScope],
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    const audio = encodeMonoPcm16Wav([new Float32Array(24_000)], 24_000);
    if (!audio) throw new Error("invalid fixture");
    const body = {
      audioBase64: uint8ArrayToBase64(audio.bytes),
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1000,
    };
    const first = yield* Effect.forkChild(h.send("transcribe", body));
    yield* Deferred.await(started);
    expect((yield* h.send("transcribe", body)).status).toBe(502);
    expect(h.transcribe).toHaveBeenCalledOnce();
    yield* Deferred.succeed(release, "done");
    expect((yield* Fiber.join(first)).status).toBe(200);
  }).pipe(Effect.scoped),
);

it.effect("serves authorized model operations and transcription", () =>
  Effect.gen(function* () {
    const h = yield* serve([AuthVoiceManageScope, AuthOrchestrationOperateScope]);
    expect((yield* h.send("models")).status).toBe(200);
    expect((yield* h.send("configure")).status).toBe(200);
    expect((yield* h.send("models/download", { modelId: "model" })).status).toBe(200);
    expect((yield* h.send("models/remove", { modelId: "model" })).status).toBe(200);
    expect((yield* h.send("configure", DEFAULT_SPEECH_CONFIGURATION)).status).toBe(200);
    const audio = encodeMonoPcm16Wav([new Float32Array(24_000)], 24_000);
    if (!audio) throw new Error("invalid fixture");
    const response = yield* h.send("transcribe", {
      audioBase64: uint8ArrayToBase64(audio.bytes),
      mimeType: "audio/wav",
      sampleRateHz: 24_000,
      durationMs: 1000,
      locale: "en-US",
    });
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ text: "recognized" });
    expect(h.download).toHaveBeenCalledWith("model");
    expect(h.remove).toHaveBeenCalledWith("model");
    expect(h.configure).toHaveBeenCalledWith(DEFAULT_SPEECH_CONFIGURATION);
    expect(h.transcribe).toHaveBeenCalledOnce();
  }).pipe(Effect.scoped),
);

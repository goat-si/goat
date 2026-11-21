import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_SPEECH_CONFIGURATION,
  encodeMonoPcm16Wav,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  SPEECH_STREAM_WS_METHODS,
  uint8ArrayToBase64,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Etag, HttpPlatform, HttpRouter } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as SpeechHttp from "./http.ts";
import * as SpeechInference from "./SpeechInference.ts";
import * as SpeechManagement from "./SpeechManagement.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import { makeSpeechStreamRpcHandlers, ServerWsSpeechStreamRpcGroup } from "./SpeechStreamRpc.ts";

class Api extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.environmentSpeech) {}

it.effect("shares one model slot between websocket streams and the existing batch HTTP path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const layer = SpeechManagement.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettingsService.layerTest({ speech: DEFAULT_SPEECH_CONFIGURATION }),
            Layer.mock(SpeechModelStore.SpeechModelStore)({
              installedPath: () => Effect.succeed("fixture.gguf"),
            }),
            Layer.mock(SpeechInference.SpeechInference)({
              transcribe: () => Effect.succeed("batch result"),
              openStream: () =>
                Effect.succeed({
                  feed: () => Effect.succeed({ revision: 0, text: null }),
                  finish: Effect.succeed("live result"),
                }),
            }),
          ),
        ),
      );
      const manager = yield* SpeechManagement.SpeechManagement.pipe(Effect.provide(layer));
      const handlers = yield* makeSpeechStreamRpcHandlers().pipe(
        Effect.provideService(SpeechManagement.SpeechManagement, manager),
      );
      const rpcLayer = Layer.mergeAll(
        ServerWsSpeechStreamRpcGroup.toLayer(handlers),
        RpcAuthorization.layer([AuthOrchestrationOperateScope]),
        Layer.succeed(RpcInstrumentation)((effect) => effect),
      );
      const client = yield* RpcTest.makeClient(ServerWsSpeechStreamRpcGroup).pipe(
        Effect.provide(rpcLayer),
      );
      const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
        effect.pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, {
            scopes: new Set([AuthOrchestrationOperateScope]),
          } as unknown as EnvironmentAuthenticatedPrincipal["Service"]),
        ),
      );
      const app = HttpApiBuilder.layer(Api).pipe(
        Layer.provide(SpeechHttp.layerHttp),
        Layer.provide(auth),
        Layer.provide(Layer.succeed(SpeechManagement.SpeechManagement, manager)),
        Layer.provideMerge(
          HttpPlatform.layer.pipe(
            Layer.provideMerge(Etag.layerWeak),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const audio = encodeMonoPcm16Wav([new Float32Array(24_000)], 24_000);
      if (!audio) throw new Error("invalid fixture");
      const body = {
        audioBase64: uint8ArrayToBase64(audio.bytes),
        mimeType: "audio/wav",
        sampleRateHz: 24_000,
        durationMs: 1_000,
      };
      const batch = () =>
        Effect.promise(() =>
          handler(
            new Request("http://localhost/api/voice/environment/transcribe", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
            Context.empty(),
          ),
        );
      const { streamId } = yield* client[SPEECH_STREAM_WS_METHODS.start]({ locale: "en" });
      expect((yield* batch()).status).toBe(502);
      yield* client[SPEECH_STREAM_WS_METHODS.cancel]({ streamId });
      const response = yield* batch();
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({ text: "batch result" });
    }),
  ),
);

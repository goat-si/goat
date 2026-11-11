import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { requiredScopesForServerSettingsPatch, ServerSettingsPatch } from "./settings.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";
import { SpeechModelList, speechBenchmarkTiers } from "./speech.ts";

const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeSpeechModelList = Schema.encodeSync(SpeechModelList);

it("keeps speech model lists compatible when benchmark references are absent or added", () => {
  const model = {
    id: "model",
    name: "Model",
    description: "",
    size: 1,
    installed: false,
    selected: false,
  };
  const decode = Schema.decodeUnknownSync(SpeechModelList);
  expect(decode({ models: [model] }).models[0]).toEqual(model);
  const benchmark = { cpu: 3, accelerated: 1 };
  expect(decode({ models: [{ ...model, benchmark }] }).models[0]?.benchmark).toEqual(benchmark);
  expect(encodeSpeechModelList(decode({ models: [{ ...model, benchmark }] }))).toEqual({
    models: [{ ...model, benchmark }],
  });
  const oldModel = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.String,
    size: Schema.Number,
    installed: Schema.Boolean,
    selected: Schema.Boolean,
  });
  expect(Schema.decodeUnknownSync(oldModel)({ ...model, benchmark })).toEqual(model);
  expect(() =>
    decode({ models: [{ ...model, benchmark: { cpu: NaN, accelerated: 1 } }] }),
  ).toThrow();
});

it("selects only the configured hardware reference and does not guess in auto mode", () => {
  expect(speechBenchmarkTiers("cpu")).toEqual(["cpu"]);
  expect(speechBenchmarkTiers('gpu:["metal","device"]')).toEqual(["accelerated"]);
  expect(speechBenchmarkTiers("auto")).toEqual(["cpu", "accelerated"]);
  expect(speechBenchmarkTiers(undefined)).toEqual(["cpu", "accelerated"]);
});

it("requires voice management authority to change speech configuration", () => {
  const patch = decodePatch({
    speech: { modelId: "handy-computer/whisper-tiny-gguf", acceleration: "cpu" },
  });
  expect(requiredScopesForServerSettingsPatch(patch)).toEqual(["voice:manage"]);
  expect(clientRpcRequiredScopes(WS_METHODS.serverUpdateSettings, { patch })).toEqual([
    "voice:manage",
  ]);
  expect(requiredScopesForServerSettingsPatch({ ...patch, enableCua: false })).toEqual([
    "settings:write",
    "voice:manage",
  ]);
});

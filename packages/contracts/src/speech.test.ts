import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { requiredScopesForServerSettingsPatch, ServerSettingsPatch } from "./settings.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

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

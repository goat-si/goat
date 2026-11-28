import { expect, it } from "@effect/vitest";
import { AuthOrchestrationOperateScope, AuthSettingsWriteScope, WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as RpcAuthorization from "./RpcAuthorization.ts";

it.effect("requires task operation when saving scripts in settings", () =>
  Effect.gen(function* () {
    const scripts = [
      { id: "setup", name: "Setup", command: "true", icon: "play", runOnWorktreeCreate: true },
    ];
    for (const patch of [
      { defaultProjectScripts: scripts },
      { projectScriptOverrides: { project: scripts } },
      { projectSettingsOverrides: { project: { defaultProjectScripts: scripts } } },
    ]) {
      const input = { patch };
      const denied = yield* Effect.flip(
        RpcAuthorization.authorizeRpcCall(
          [AuthSettingsWriteScope],
          WS_METHODS.serverUpdateSettings,
          input,
        ),
      );
      expect(denied.requiredPermission).toBe(AuthOrchestrationOperateScope);
      yield* RpcAuthorization.authorizeRpcCall(
        [AuthSettingsWriteScope, AuthOrchestrationOperateScope],
        WS_METHODS.serverUpdateSettings,
        input,
      );
    }
    yield* RpcAuthorization.authorizeRpcCall(
      [AuthSettingsWriteScope],
      WS_METHODS.serverUpdateSettings,
      { patch: { projectScriptOverrides: { project: null } } },
    );
  }),
);

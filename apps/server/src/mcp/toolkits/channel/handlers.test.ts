import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ChannelLedger from "../../../channels/ChannelLedger.ts";
import { environmentId, makeHarness } from "../../../channels/testkit/ChannelHarness.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ChannelHandlers from "./handlers.ts";
import { ChannelToolkit } from "./tools.ts";

it.effect.each(["ingest", "read"] as const)("MCP %s follows home ownership", (operation) => {
  const harness = makeHarness();
  const other = EnvironmentId.make("environment:other-home");
  const scope = Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId,
    capabilities: new Set(["orchestration"] as const),
    issuedAt: 0,
    requestNamespace: "home-tools",
    thread: undefined,
    client: { sessionId: "home-tools", label: "Agent", access: "full-access" },
  });
  return Effect.gen(function* () {
    const toolkit = yield* ChannelToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(ChannelHandlers.layer)),
    );
    const original = yield* toolkit
      .handle("channel_ingest", { text: "hello", clientRequestId: "before-move" })
      .pipe(Stream.unwrap, Stream.runCollect);
    const receipt = original.at(-1)!.result;
    assert.isTrue("inputId" in receipt, JSON.stringify(receipt));
    if (!("inputId" in receipt)) return;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({
      goatBotHome: { environmentId: other, claimedAt: 1, claimId: "home" },
    });
    const ledger = yield* ChannelLedger.ChannelLedger;
    const pending = yield* ledger.listPendingInputs(100);
    if (operation === "ingest") {
      const result = yield* toolkit
        .handle("channel_ingest", { text: "hello", clientRequestId: "after-move" })
        .pipe(Stream.unwrap, Stream.runCollect);
      const failure = result.at(-1)!.result;
      assert.isTrue("code" in failure);
      if ("code" in failure) {
        assert.strictEqual(failure.code, "not_home");
        assert.include(failure.message, other);
      }
      assert.deepStrictEqual(yield* ledger.listPendingInputs(100), pending);
    } else {
      const read = yield* toolkit
        .handle("channel_input_get", { inputId: receipt.inputId })
        .pipe(Stream.unwrap, Stream.runCollect);
      const snapshot = read.at(-1)!.result;
      assert.isTrue("inputId" in snapshot);
      if ("inputId" in snapshot) assert.strictEqual(snapshot.inputId, receipt.inputId);
    }
  }).pipe(Effect.provide(Layer.merge(scope, harness.layer)));
});

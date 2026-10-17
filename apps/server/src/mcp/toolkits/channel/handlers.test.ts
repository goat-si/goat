import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ChannelGateway from "../../../channels/ChannelGateway.ts";
import * as ChannelReceptionService from "../../../channels/ChannelReceptionService.ts";
import { commitTransition } from "../../../channels/channelTaskWrites.ts";
import * as ChannelLedger from "../../../channels/ChannelLedger.ts";
import {
  environmentId,
  makeHarness,
  goatInput,
  onlyTask,
  rpcContext,
  setupBot,
} from "../../../channels/testkit/ChannelHarness.ts";
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

it.effect.each(["owner", "another-owner"] as const)(
  "read-only export filters %s terminal events",
  (caller) => {
    const harness = makeHarness();
    const scope = Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: caller === "owner" ? environmentId : EnvironmentId.make("environment:other"),
      capabilities: new Set(["orchestration"] as const),
      issuedAt: 0,
      requestNamespace: "export-tools",
      thread: undefined,
      client: { sessionId: "export-tools", label: "Reader", access: "read-only" },
    });
    return Effect.gen(function* () {
      yield* setupBot;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* ledger.claimOwnership({ token: "export-owner", now, staleBefore: now });
      const input = yield* gateway.ingest(
        goatInput("do: export old work", "export-old"),
        rpcContext,
      );
      yield* reception.receive(input.inputId, "export-owner");
      const task = yield* onlyTask;
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.cancelled",
          payload: { reason: "No longer needed" },
        },
        { owner: "export-owner" },
      );
      const toolkit = yield* ChannelToolkit.pipe(
        Effect.provide(McpToolAccess.HandlersLayer.layer(ChannelHandlers.layer)),
      );
      const result = yield* toolkit
        .handle("channel_task_export", {
          from: now,
          to: "9999-12-31T23:59:59.999Z",
          limit: 1,
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      const page = result.at(-1)!.result;
      assert.isTrue("jsonl" in page);
      if (!("jsonl" in page)) return;
      if (caller === "owner") {
        assert.include(page.jsonl, task.taskId);
        assert.include(page.jsonl, '"brief":null');
        assert.include(page.jsonl, '"terminalState":"cancelled"');
      } else {
        assert.strictEqual(page.jsonl, "");
      }
    }).pipe(Effect.provide(Layer.merge(scope, harness.layer)));
  },
);

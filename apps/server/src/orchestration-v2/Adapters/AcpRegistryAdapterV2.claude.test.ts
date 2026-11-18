import {
  CLAUDE_ROOT_SESSION,
  claudeFrames,
  openClaudeReplaySession,
  claudeMarker,
  claudeChild,
} from "./AcpClaudeReplay.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import { makeProviderReplayGate } from "@goat/provider-testing/replayGate";
import { layerTest } from "./AcpRegistryAdapterV2.host.testkit.ts";

describe("AcpRegistryAdapterV2 Claude Stop", () => {
  it.effect("keeps Claude activity after a refused Stop and closes it on retry", () =>
    Effect.gen(function* () {
      const gate = makeProviderReplayGate(["close-response", "queued-close-response"]);
      const session = yield* openClaudeReplaySession(
        [
          ...claudeFrames.open,
          ...claudeFrames.prompt(1),
          ...claudeChild,
          claudeMarker("before Stop"),
          claudeFrames.closeRequest,
          claudeFrames.update("child-1", {
            sessionUpdate: "agent_message_chunk",
            messageId: "closing-reply",
            content: { type: "text", text: "Finished during close." },
          }),
          claudeFrames.childState(CLAUDE_ROOT_SESSION, "child-1", "idle"),
          claudeFrames.idle("end_turn"),
          claudeMarker("idle during close"),
          {
            type: "emit_inbound",
            label: "close-response",
            frame: {
              kind: "response",
              method: "session/close",
              error: { code: -32603, message: "Close refused" },
            },
          },
          ...claudeFrames.prompt(2),
          claudeMarker("before retry"),
          claudeFrames.closeRequest,
          claudeFrames.idle("cancelled"),
          claudeFrames.closed,
        ],
        gate,
      );
      yield* session.runtime.startTurn(session.turnInput(1));
      const started = yield* session.throughMarker("before Stop");
      const running = started.findLast((event) => event.type === "provider_turn.updated");
      if (running?.type !== "provider_turn.updated") throw new Error("Missing active turn");
      const stop = {
        providerThread: session.providerThread,
        providerTurnId: running.providerTurn.id,
        requestRuntimeRestart: true,
      };
      const closing = yield* session.runtime
        .interruptTurn(stop)
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.addFinalizer(() => Effect.sync(() => gate.releaseAll()));
      const idle = yield* session.throughMarker("idle during close");
      gate.release("close-response");
      const refused = yield* Fiber.join(closing);
      assert.isTrue(Exit.isFailure(refused), "a refused close must not report a successful Stop");
      const terminal = idle.findLast((event) => event.type === "turn.terminal");
      assert.equal(
        terminal?.type === "turn.terminal" ? terminal.status : null,
        "completed",
        "idle during a refused close must settle the foreground turn",
      );
      const result = idle.findLast((event) => event.type === "subagent.updated");
      if (result?.type !== "subagent.updated") throw new Error("Missing child close-time result");
      assert.equal(result.subagent.status, "completed");
      assert.equal(result.subagent.result, "Finished during close.");
      assert.isFalse(yield* session.runtime.hasPendingBackgroundWork!);
      yield* session.runtime.startTurn(session.turnInput(2));
      const retry = yield* session.throughMarker("before retry");
      const retryRunning = retry.findLast((event) => event.type === "provider_turn.updated");
      if (retryRunning?.type !== "provider_turn.updated")
        throw new Error("Missing active retry turn");
      yield* session.runtime.interruptTurn({
        ...stop,
        providerTurnId: retryRunning.providerTurn.id,
      });
      assert.equal((yield* session.terminal).status, "interrupted");
      assert.isFalse(yield* session.runtime.hasPendingBackgroundWork!);

      const queued = yield* openClaudeReplaySession(
        [
          ...claudeFrames.open,
          {
            type: "expect_outbound",
            frame: { kind: "request", method: "session/prompt", params: "<any>" },
          },
          claudeMarker("before queued Stop"),
          claudeFrames.closeRequest,
          {
            type: "emit_inbound",
            frame: {
              kind: "response",
              method: "session/prompt",
              error: { code: -32800, message: "Request cancelled" },
            },
          },
          { ...claudeFrames.closed, label: "queued-close-response" },
        ],
        gate,
      );
      yield* queued.runtime.startTurn(queued.turnInput(3));
      const pending = yield* queued.throughMarker("before queued Stop");
      const queuedRunning = pending.findLast((event) => event.type === "provider_turn.updated");
      if (queuedRunning?.type !== "provider_turn.updated")
        throw new Error("Missing queued provider turn");
      const queuedClosing = yield* queued.runtime
        .interruptTurn({
          providerThread: queued.providerThread,
          providerTurnId: queuedRunning.providerTurn.id,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.forkScoped);
      const queuedTerminal = yield* queued.terminal;
      gate.release("queued-close-response");
      yield* Fiber.join(queuedClosing);
      assert.equal(queuedTerminal.providerTurnId, queuedRunning.providerTurn.id);
      assert.equal(queuedTerminal.status, "interrupted");
      assert.isNull(queuedTerminal.failure);
      assert.isFalse(yield* queued.runtime.hasPendingBackgroundWork!);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});

import type { InteractionUpdate } from "@cursor/sdk";
import * as Effect from "effect/Effect";

export const connectionFailureCases = (
  [
    {
      reason: "no failure when the connection fails after the turn ended",
      updates: [
        { type: "text-delta", text: "Done." },
        { type: "turn-ended" },
      ] satisfies ReadonlyArray<InteractionUpdate>,
      wait: Effect.succeed({
        id: "native-cursor-run",
        requestId: "native-request",
        status: "error" as const,
        error: { message: "Connection failed repeatedly" },
        model: { id: "claude-fable-5" },
        durationMs: 1,
      }),
      failure: null,
    },
    {
      reason: "a connection failure before the turn ends",
      updates: [
        { type: "text-delta", text: "Working." },
      ] satisfies ReadonlyArray<InteractionUpdate>,
      wait: Effect.succeed({
        id: "native-cursor-run",
        requestId: "native-request",
        status: "error" as const,
        error: { message: "Connection failed repeatedly" },
        model: { id: "claude-fable-5" },
        durationMs: 1,
      }),
      failure: { class: "provider_error", message: "Connection failed repeatedly" },
    },
    {
      reason: "a connection failure during a continuation after the turn ended",
      updates: [
        { type: "text-delta", text: "Done." },
        { type: "turn-ended" },
        { type: "step-started", stepId: 2 },
      ] satisfies ReadonlyArray<InteractionUpdate>,
      wait: Effect.succeed({
        id: "native-cursor-run",
        requestId: "native-request",
        status: "error" as const,
        error: { message: "Connection failed repeatedly" },
        model: { id: "claude-fable-5" },
        durationMs: 1,
      }),
      failure: { class: "provider_error", message: "Connection failed repeatedly" },
    },
  ] as const
).map((item) => ({ answers: undefined, usage: undefined, contextFill: undefined, ...item }));

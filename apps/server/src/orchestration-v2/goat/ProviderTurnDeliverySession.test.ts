import { it } from "@effect/vitest";
import { ProviderDriverKind, RunId } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { submitWithContextHandoff } from "./ProviderTurnDeliverySession.ts";

it.effect("retains an inline handoff when a Cursor turn fails before accepting its prompt", () =>
  Effect.gen(function* () {
    let handoff = "pending";
    let submitted = 0;
    let accepted = 0;
    let text = "";
    const input = {
      runId: RunId.make("run-fake-cursor"),
      message: { text: "continue" },
      inputDelivery: {
        begin: () => Effect.succeed(true),
        submitted: () =>
          Effect.sync(() => {
            submitted++;
          }),
        accepted: () =>
          Effect.sync(() => {
            accepted++;
          }),
        skipped: () => Effect.void,
        inherited: () => Effect.void,
      },
    } as unknown as ProviderAdapter.ProviderAdapterV2TurnInput;
    const fakeCursor: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"] = (turn) =>
      Effect.gen(function* () {
        text = turn.message.text;
        yield* turn.inputDelivery?.submitted() ?? Effect.void;
        // A failed native run emits a terminal after startTurn, without accepting the prompt.
      });
    const delivery = {
      delivered: Effect.sync(() => {
        handoff = "inline";
      }),
      unsent: Effect.sync(() => {
        handoff = "pending";
      }),
    };
    yield* submitWithContextHandoff(
      fakeCursor,
      input,
      delivery,
      "previous context",
      ProviderDriverKind.make("cursor"),
    );
    expect(text).toContain("previous context");
    expect(submitted).toBe(1);
    expect(accepted).toBe(0);
    expect(handoff).toBe("pending");
    const acceptedCursor: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"] = (turn) =>
      Effect.gen(function* () {
        yield* turn.inputDelivery?.submitted() ?? Effect.void;
        yield* turn.inputDelivery?.accepted() ?? Effect.void;
      });
    yield* submitWithContextHandoff(
      acceptedCursor,
      input,
      delivery,
      "previous context",
      ProviderDriverKind.make("cursor"),
    );
    expect(handoff).toBe("inline");
    expect(accepted).toBe(1);
  }),
);

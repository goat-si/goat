import { assert, describe, it } from "@effect/vitest";
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  EnvironmentId,
  type Handoff,
  HandoffError,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { transitionHandoff } from "./handoffState.ts";

const grant = (overrides: Partial<Handoff> = {}): Handoff => ({
  handoffId: TurnItemId.make("handoff:grant"),
  kind: "approval",
  title: "Allow computer use on host?",
  reason: "Bot asks",
  requestedBy: {
    threadId: ThreadId.make("bot"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    path: COMPUTER_USE_GRANT_HANDOFF_PATH,
  },
  target: { environmentId: EnvironmentId.make("host"), path: COMPUTER_USE_GRANT_HANDOFF_PATH },
  dedupeKey: "key",
  state: "pending",
  expiresAt: DateTime.makeUnsafe(30 * 60_000),
  createdAt: DateTime.makeUnsafe(0),
  actor: { type: "agent", threadId: ThreadId.make("bot") },
  ...overrides,
});
const person = { type: "client", label: "Jun's Mac" } as const;
const minute = (n: number) => DateTime.makeUnsafe(n * 60_000);

describe("computer use grant handoffs", () => {
  it.effect("outlive the turn that asked and expire on their clock", () =>
    Effect.gen(function* () {
      // The bot turn ended; the person approves later and it still counts.
      const approved = yield* transitionHandoff(grant(), "completed", person, minute(10), true);
      assert.equal(approved.state, "completed");
      const late = yield* transitionHandoff(grant(), "completed", person, minute(31), true);
      assert.equal(late.state, "expired");
    }),
  );

  it.effect("let a person end an approved grant early, and nothing else reopen it", () =>
    Effect.gen(function* () {
      const approved = grant({ state: "completed", resolvedAt: minute(5), resolvedBy: "Jun" });
      const ended = yield* transitionHandoff(approved, "cancelled", person, minute(12), false);
      assert.equal(ended.state, "cancelled");
      assert.equal(ended.resolvedBy, "Jun's Mac");
      const refused = (exit: Exit.Exit<unknown, unknown>) =>
        assert.deepEqual(exit, Exit.fail(new HandoffError({ reason: "conflict" })));
      // The agent cannot end or restore it, and an expired or ended grant stays that way.
      refused(
        yield* transitionHandoff(
          approved,
          "cancelled",
          { type: "agent", threadId: ThreadId.make("bot") },
          minute(12),
          false,
        ).pipe(Effect.exit),
      );
      refused(
        yield* transitionHandoff(approved, "cancelled", person, minute(31), false).pipe(
          Effect.exit,
        ),
      );
      refused(
        yield* transitionHandoff(ended, "completed", person, minute(13), false).pipe(Effect.exit),
      );
      // Other approvals keep their immutable decisions.
      const other = grant({
        state: "completed",
        requestedBy: { ...approved.requestedBy, path: "provider.home_request" },
        target: { ...approved.target, path: "provider.home_request" },
      });
      refused(
        yield* transitionHandoff(other, "cancelled", person, minute(12), false).pipe(Effect.exit),
      );
    }),
  );
});

import { ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";

import {
  isTerminalProviderTurn,
  providerTurnsForThread,
  terminalTurnsAfterBoundary,
} from "./CodexTurnHistory.ts";

const CODEX_PROVIDER = ProviderDriverKind.make("codex");

const resolveCodexForkRollbackTurnCount = Effect.fn("CodexAdapterV2.resolveForkRollbackTurnCount")(
  function* (input: ProviderAdapter.ProviderAdapterV2ForkThreadInput) {
    if (input.providerTurnId === undefined || input.sourceProviderTurns === undefined) {
      return 0;
    }

    const rollbackTurns = terminalTurnsAfterBoundary(
      providerTurnsForThread(input.sourceProviderTurns, input.sourceProviderThread),
      input.providerTurnId,
    );
    if (rollbackTurns === null) {
      return yield* new ProviderAdapter.ProviderAdapterForkThreadError({
        driver: CODEX_PROVIDER,
        providerThreadId: input.sourceProviderThread.id,
        cause: `Cannot fork Codex thread from provider turn ${input.providerTurnId}: source turn was not found in provider thread ${input.sourceProviderThread.id}.`,
      });
    }

    return rollbackTurns.length;
  },
);

/** Codex lastTurnId is inclusive, atomically omitting later turns even in paginated threads. */
export const resolveCodexForkBoundary = Effect.fn("CodexAdapterV2.resolveForkBoundary")(function* (
  input: ProviderAdapter.ProviderAdapterV2ForkThreadInput,
) {
  const rollbackTurnCount = yield* resolveCodexForkRollbackTurnCount(input);
  if (input.providerTurnId === undefined || input.sourceProviderTurns === undefined) {
    return { lastTurnId: undefined, rollbackTurnCount };
  }

  const boundaryTurn = providerTurnsForThread(
    input.sourceProviderTurns,
    input.sourceProviderThread,
  ).find((turn) => turn.id === input.providerTurnId);
  const nativeTurnId = boundaryTurn?.nativeTurnRef?.nativeId;
  if (nativeTurnId === null || nativeTurnId === undefined) {
    return { lastTurnId: undefined, rollbackTurnCount };
  }

  return { lastTurnId: nativeTurnId, rollbackTurnCount: 0 };
});

export const resolveCodexRollbackTurns = Effect.fn("CodexAdapterV2.resolveRollbackTurns")(
  function* (input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) {
    const providerTurns = input.providerThreadTurns;
    switch (input.target.type) {
      case "thread_start":
        return providerTurns.filter(isTerminalProviderTurn);
      case "provider_turn": {
        if (input.target.providerTurn.providerThreadId !== input.providerThread.id) {
          return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
            driver: CODEX_PROVIDER,
            providerThreadId: input.providerThread.id,
            cause: `Cannot roll back Codex thread ${input.providerThread.id} to provider turn ${input.target.providerTurn.id}: target turn belongs to provider thread ${input.target.providerTurn.providerThreadId}.`,
          });
        }

        const rollbackTurns = terminalTurnsAfterBoundary(
          providerTurns,
          input.target.providerTurn.id,
        );
        if (rollbackTurns === null) {
          return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
            driver: CODEX_PROVIDER,
            providerThreadId: input.providerThread.id,
            cause: `Cannot roll back Codex thread ${input.providerThread.id} to provider turn ${input.target.providerTurn.id}: target turn was not found in durable provider turn history.`,
          });
        }

        return rollbackTurns;
      }
    }
  },
);

export const resolveCodexRollbackTurnCount = Effect.fn("CodexAdapterV2.resolveRollbackTurnCount")(
  (input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
    resolveCodexRollbackTurns(input).pipe(Effect.map((turns) => turns.length)),
);

export const resolveCodexRollbackPlan = Effect.fn("CodexAdapterV2.resolveRollbackPlan")(function* (
  input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput,
  nativeThreadId: string,
) {
  const rollbackTurns = yield* resolveCodexRollbackTurns(input);
  const nativeConversationHeadRef =
    input.target.type === "provider_turn" ? input.target.providerTurn.nativeTurnRef : null;
  const keptNativeTurnId = nativeConversationHeadRef?.nativeId ?? null;
  const nativeTurnIds = rollbackTurns.flatMap((turn) => turn.nativeTurnRef?.nativeId ?? []);
  if (rollbackTurns.length > 0 && keptNativeTurnId === null && nativeTurnIds.length === 0) {
    return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
      driver: CODEX_PROVIDER,
      providerThreadId: input.providerThread.id,
      cause: `Cannot roll back Codex thread ${nativeThreadId}: no recorded native turn IDs are available for the turns being removed.`,
    });
  }
  return {
    numTurns: rollbackTurns.length,
    nativeConversationHeadRef,
    keptNativeTurnId,
    nativeTurnIds,
  };
});

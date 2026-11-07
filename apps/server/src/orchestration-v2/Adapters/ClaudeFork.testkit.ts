import {
  ProviderTurnId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type ProviderDriverKind,
} from "@goat/contracts";
import { assert } from "@effect/vitest";

export function assertPinnedHead(thread: OrchestrationV2ProviderThread, cursor: string) {
  assert.equal(thread.nativeConversationHeadRef?.nativeId, cursor);
}

export function makeTurnsAcrossSilent(
  providerTurn: OrchestrationV2ProviderTurn,
  earlierCursor: string,
  driver: ProviderDriverKind,
) {
  return [
    {
      ...providerTurn,
      id: ProviderTurnId.make("provider-turn-claude-cursor-earlier"),
      ordinal: providerTurn.ordinal - 1,
      nativeTurnRef: { driver, nativeId: earlierCursor, strength: "weak" as const },
    },
    providerTurn,
    {
      ...providerTurn,
      id: ProviderTurnId.make("provider-turn-claude-cursor-next"),
      ordinal: providerTurn.ordinal + 1,
    },
  ];
}

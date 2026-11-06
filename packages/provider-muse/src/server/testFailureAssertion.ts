import { assert } from "@effect/vitest";
import type { ProviderAdapterV2Event } from "@goat/provider-core/server/ProviderAdapter";

export function assertRedactedMuseFailure(
  message: string | undefined,
  events: ReadonlyArray<ProviderAdapterV2Event>,
) {
  assert.strictEqual(message, "Provider rejected this turn: api_key=[REDACTED]");
  assert.strictEqual(
    events.findLast((event) => event.type === "provider_session.updated")?.providerSession
      .lastError,
    message,
  );
}

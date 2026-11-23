import * as Effect from "effect/Effect";

export interface PendingMemoryReceiptOwner {
  pendingMemoryReceipt?: { readonly id: string; readonly receipt: Effect.Effect<void> } | undefined;
}

export function takeMemoryReceipt(
  owner: PendingMemoryReceiptOwner,
  id: string,
  delivered: boolean,
) {
  const pending = owner.pendingMemoryReceipt;
  if (pending?.id !== id) return Effect.void;
  owner.pendingMemoryReceipt = undefined;
  return delivered ? pending.receipt : Effect.void;
}

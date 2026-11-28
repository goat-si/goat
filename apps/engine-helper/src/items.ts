// Builders for the TurnItems engines emit. The Rust driver adds threadId, runId, ordinal and
// providerThreadId (see ../PROTOCOL.md).
import type { HelperItem } from "./protocol.ts";

type Item<T extends HelperItem["type"]> = Extract<HelperItem, { type: T }>;
type BodyOf<T extends HelperItem["type"]> = Omit<
  Item<T>,
  | "id"
  | "providerTurnId"
  | "nativeItemRef"
  | "parentItemId"
  | "status"
  | "title"
  | "startedAt"
  | "completedAt"
  | "updatedAt"
  | "type"
>;

export interface ItemBase {
  readonly id: string;
  readonly turnId: string;
  /** The engine's driver slug for `nativeItemRef.driver` (v1 ProviderDriverKind). */
  readonly driver: string;
  /** The engine's own id for this item, when it has one. */
  readonly nativeId?: string | null;
  readonly strength?: "strong" | "weak" | "none";
  readonly parentItemId?: string | null;
  readonly status?: HelperItem["status"];
  readonly title?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly now: string;
}

export function item<T extends HelperItem["type"]>(base: ItemBase, type: T, body: BodyOf<T>): HelperItem {
  const nativeId = base.nativeId ?? null;
  return {
    id: base.id,
    providerTurnId: base.turnId,
    nativeItemRef: {
      driver: base.driver,
      nativeId,
      strength: base.strength ?? (nativeId === null ? "none" : "strong"),
    },
    parentItemId: base.parentItemId ?? null,
    status: base.status ?? "completed",
    title: base.title ?? null,
    startedAt: base.startedAt ?? null,
    completedAt: base.completedAt ?? base.now,
    updatedAt: base.now,
    type,
    ...body,
  } as HelperItem;
}

export function assistantMessage(base: ItemBase, text: string, messageId?: string): HelperItem {
  return item(base, "assistant_message", {
    messageId: messageId ?? base.id,
    text,
    streaming: false,
  } as BodyOf<"assistant_message">);
}

export function reasoning(base: ItemBase, text: string): HelperItem {
  return item(base, "reasoning", { text, streaming: false } as BodyOf<"reasoning">);
}

export function systemNotice(
  base: ItemBase,
  message: string,
  severity?: "info" | "warning" | "error",
): HelperItem {
  return item(base, "system_notice", {
    message,
    ...(severity === undefined ? {} : { severity }),
  } as BodyOf<"system_notice">);
}

export function errorItem(
  base: ItemBase,
  message: string,
  failureClass: "usage_limit" | "provider_error" | "transport_error" | "permission_error" | "validation_error" | "unknown" = "provider_error",
): HelperItem {
  return item(base, "error", {
    failure: { class: failureClass, message, code: null, retryable: null },
  } as BodyOf<"error">);
}
